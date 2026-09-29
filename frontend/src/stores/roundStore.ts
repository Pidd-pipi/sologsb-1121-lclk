import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import {
  ArchiveConflictError,
  ArchiveLockedError,
  draftOf,
  latestPublishedOf,
  sortArchives,
  toSnapshotDiff,
  toSnapshotRegen,
  toSnapshotTree,
  type RoundArchive,
  type RoundSnapshot,
} from '../types/roundArchive';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import type { TreeRecord } from '../types/tree';
import { broadcastChange } from '../utils/dbSync';

/** 结构变化后广播给其他终端（发布 / 开新期 / 修订 / 锁定 / 作废 / 删除） */
export interface ArchiveChangedDetail {
  plotId: string;
  reason: 'publish' | 'next' | 'revise' | 'discard' | 'lock' | 'remove';
}
export function emitArchiveChanged(detail: ArchiveChangedDetail): void {
  try {
    broadcastChange({ table: 'rounds', plotId: detail.plotId });
    broadcastChange({ table: 'trees', plotId: detail.plotId });
    broadcastChange({ table: 'regens', plotId: detail.plotId });
    if (detail.reason === 'publish' || detail.reason === 'discard' || detail.reason === 'remove') {
      broadcastChange({ table: 'rechecks', plotId: detail.plotId });
    }
  } catch {
    /* 非浏览器环境忽略 */
  }
}

interface RoundState {
  items: RoundArchive[];
  loaded: boolean;
  load: () => Promise<void>;
  byPlot: (plotId: string) => RoundArchive[];
  getById: (id: string) => RoundArchive | undefined;
  /** 为新建样地建第 1 期草稿（随样地一起放入同一事务更稳妥，这里由 plotStore 调用） */
  createFirstRound: (plotId: string, now: number) => Promise<RoundArchive>;
  /** 以最近一次已发布快照为准开下一期；未发布草稿不会混入；连续点击只生成一期 */
  startNextRound: (plotId: string) => Promise<RoundArchive>;
  /** 从某份已发布原期生成修订期草稿，原快照保留可查 */
  reviseFrom: (sourceId: string) => Promise<RoundArchive>;
  /** 发布草稿：定格样木、更新层、复查结果；带在途锁与乐观锁 */
  publish: (roundId: string) => Promise<RoundArchive>;
  /** 作废草稿（活动行随草稿删除） */
  discardDraft: (roundId: string) => Promise<void>;
  /** 切换锁定（草稿可直接切；已发布期只改档案锁标记，不动快照） */
  toggleLock: (roundId: string) => Promise<RoundArchive>;
  /** 样地被删除时连带清理 */
  removeByPlot: (plotId: string) => Promise<void>;
  /** 乐观锁自增：活动行每保存一次草稿版本 +1，防止两个终端互相覆盖 */
  bumpVersion: (roundId: string, expectedVersion: number) => Promise<void>;
}

/** 在途操作去重：同一档案/同一样地的关键动作重入时直接返回进行中的 Promise */
const inflight = new Map<string, Promise<unknown>>();
function dedupe<T>(key: string, task: () => Promise<T>): Promise<T> {
  const going = inflight.get(key);
  if (going) return going as Promise<T>;
  const job = task().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** 从发布快照克隆出一期的活动行 */
function cloneTreesFromSnapshot(plotId: string, roundId: string, roundNo: number, archive: RoundArchive): TreeRecord[] {
  return (archive.snapshot?.trees ?? []).map((t) => ({
    ...t,
    id: newId('tree'),
    plotId,
    round: roundNo,
    roundId,
  }));
}

function cloneRegensFromSnapshot(plotId: string, roundId: string, roundNo: number, archive: RoundArchive): RegenShrub[] {
  return (archive.snapshot?.regens ?? []).map((r) => ({
    ...r,
    id: newId('regen'),
    plotId,
    round: roundNo,
    roundId,
  }));
}

function cloneDiffsFromSnapshot(plotId: string, roundId: string, roundNo: number, archive: RoundArchive): RecheckDiff[] {
  return (archive.snapshot?.diffs ?? []).map((d) => ({
    ...d,
    id: newId('diff'),
    plotId,
    roundId,
    baseRound: d.baseRound,
    targetRound: roundNo,
    generatedAt: Date.now(),
  }));
}

export const useRoundStore = create<RoundState>((set, get) => ({
  items: [],
  loaded: false,

  async load() {
    const rows = await db.rounds.toArray();
    set({ items: sortArchives(rows), loaded: true });
  },

  byPlot(plotId) {
    return sortArchives(get().items.filter((a) => a.plotId === plotId));
  },

  getById(id) {
    return get().items.find((a) => a.id === id);
  },

  async createFirstRound(plotId, now) {
    const archive: RoundArchive = {
      id: newId('round'),
      plotId,
      roundNo: 1,
      revisionSeq: 0,
      status: 'draft',
      version: 1,
      sourceRoundId: null,
      originRoundId: null,
      baseRoundId: null,
      locked: false,
      createdAt: now,
      publishedAt: null,
      snapshot: null,
    };
    await db.rounds.put(archive);
    set({ items: sortArchives([...get().items, archive]) });
    return archive;
  },

  async startNextRound(plotId) {
    return dedupe(`next:${plotId}`, async () => {
      const archives = await db.rounds.where('plotId').equals(plotId).toArray();
      if (archives.some((a) => a.status === 'draft')) {
        throw new Error('仍有未发布草稿，请先发布或作废草稿，再开始下一期');
      }
      const basis = latestPublishedOf(archives);
      const roundNo = basis ? basis.roundNo + 1 : 1;
      const now = Date.now();
      const archive: RoundArchive = {
        id: newId('round'),
        plotId,
        roundNo,
        revisionSeq: 0,
        status: 'draft',
        version: 1,
        sourceRoundId: null,
        originRoundId: null,
        baseRoundId: basis?.id ?? null,
        locked: false,
        createdAt: now,
        publishedAt: null,
        snapshot: null,
      };

      // 新期活动行只从最近一次已发布快照克隆，未发布草稿不可能混入
      const trees = basis ? cloneTreesFromSnapshot(plotId, archive.id, roundNo, basis) : [];
      const regens = basis ? cloneRegensFromSnapshot(plotId, archive.id, roundNo, basis) : [];

      await db.transaction('rw', db.rounds, db.trees, db.regens, async () => {
        await db.rounds.put(archive);
        if (trees.length) await db.trees.bulkPut(trees);
        if (regens.length) await db.regens.bulkPut(regens);
      });
      set({ items: sortArchives([...get().items, archive]) });
      emitArchiveChanged({ plotId, reason: 'next' });
      return archive;
    });
  },

  async reviseFrom(sourceId) {
    return dedupe(`revise:${sourceId}`, async () => {
      const source = await db.rounds.get(sourceId);
      if (!source) throw new Error('来源期档案不存在');
      if (source.status === 'draft') throw new ArchiveLockedError('草稿本身就可改，不需要生成修订期');
      const siblings = await db.rounds.where('plotId').equals(source.plotId).toArray();
      if (siblings.some((a) => a.status === 'draft')) {
        throw new Error('该样地已有未发布草稿，请先发布或作废当前草稿');
      }
      const revisionSeq =
        siblings
          .filter((a) => a.roundNo === source.roundNo)
          .reduce((max, a) => Math.max(max, a.revisionSeq), 0) + 1;
      const now = Date.now();
      const archive: RoundArchive = {
        id: newId('round'),
        plotId: source.plotId,
        roundNo: source.roundNo,
        revisionSeq,
        status: 'draft',
        version: 1,
        sourceRoundId: source.id,
        originRoundId: source.originRoundId ?? source.id,
        baseRoundId: source.baseRoundId,
        locked: false,
        createdAt: now,
        publishedAt: null,
        snapshot: null,
      };

      // 修订草稿以原期快照为底，连同原期复查结果一起带出供修订
      const trees = cloneTreesFromSnapshot(source.plotId, archive.id, source.roundNo, source);
      const regens = cloneRegensFromSnapshot(source.plotId, archive.id, source.roundNo, source);
      const diffs = cloneDiffsFromSnapshot(source.plotId, archive.id, source.roundNo, source);

      await db.transaction('rw', db.rounds, db.trees, db.regens, db.rechecks, async () => {
        await db.rounds.put(archive);
        if (trees.length) await db.trees.bulkPut(trees);
        if (regens.length) await db.regens.bulkPut(regens);
        if (diffs.length) await db.rechecks.bulkPut(diffs);
      });
      set({ items: sortArchives([...get().items, archive]) });
      emitArchiveChanged({ plotId: source.plotId, reason: 'revise' });
      return archive;
    });
  },

  async publish(roundId) {
    return dedupe(`publish:${roundId}`, async () => {
      const existing = await db.rounds.get(roundId);
      if (!existing) throw new Error('期次档案不存在');
      // 重复点击 / 其他终端已抢先发布：直接返回现有档案，不会多出期次或版本
      if (existing.status !== 'draft' || existing.snapshot) return existing;

      const expectedVersion = existing.version;
      const payload: RoundSnapshot = {
        trees: [],
        regens: [],
        diffs: [],
        locked: existing.locked,
        savedAt: 0,
      };

      // 读活动行 + CAS 置快照在同一事务：其他终端刚改过草稿（版本变化）时本事务抛错回滚
      let concurrentPublish = false;
      await db.transaction('rw', db.rounds, db.trees, db.regens, db.rechecks, async () => {
        const [trees, regens, diffs] = await Promise.all([
          db.trees.where('roundId').equals(roundId).toArray(),
          db.regens.where('roundId').equals(roundId).toArray(),
          db.rechecks.where('roundId').equals(roundId).toArray(),
        ]);
        payload.trees = trees.map(toSnapshotTree);
        payload.regens = regens.map(toSnapshotRegen);
        payload.diffs = diffs.map(toSnapshotDiff);
        payload.savedAt = Date.now();

        let changed = 0;
        await db.rounds
          .where('id')
          .equals(roundId)
          .and((a) => a.status === 'draft' && a.version === expectedVersion)
          .modify((a: RoundArchive) => {
            a.status = existing.sourceRoundId ? 'revision' : 'published';
            a.version = expectedVersion + 1;
            a.locked = existing.locked;
            a.publishedAt = payload.savedAt;
            a.snapshot = {
              trees: payload.trees,
              regens: payload.regens,
              diffs: payload.diffs,
              locked: existing.locked,
              savedAt: payload.savedAt,
            };
            changed += 1;
          });
        if (changed === 0) {
          const latest = await db.rounds.get(roundId);
          if (latest && latest.status !== 'draft' && latest.snapshot) {
            concurrentPublish = true;
            return;
          }
          throw new ArchiveConflictError();
        }
        // 快照定格后，活动行只属于草稿：同事务清掉本期的活动表行，数据以快照为准
        await db.trees.where('roundId').equals(roundId).delete();
        await db.regens.where('roundId').equals(roundId).delete();
        await db.rechecks.where('roundId').equals(roundId).delete();
      });

      const after = await db.rounds.get(roundId);
      if (!after) throw new Error('期次档案不存在');
      if (concurrentPublish) {
        // 已被并发发布：以库里的档案为准，不重复发布、不重复广播
        set({ items: sortArchives(get().items.map((a) => (a.id === roundId ? after : a))) });
        return after;
      }
      set({ items: sortArchives(get().items.map((a) => (a.id === roundId ? after : a))) });
      emitArchiveChanged({ plotId: after.plotId, reason: 'publish' });
      return after;
    });
  },

  async discardDraft(roundId) {
    return dedupe(`discard:${roundId}`, async () => {
      const archive = await db.rounds.get(roundId);
      if (!archive) return;
      if (archive.status !== 'draft') throw new ArchiveLockedError('已发布档案不能作废');
      await db.transaction('rw', db.rounds, db.trees, db.regens, db.rechecks, async () => {
        await db.trees.where('roundId').equals(roundId).delete();
        await db.regens.where('roundId').equals(roundId).delete();
        await db.rechecks.where('roundId').equals(roundId).delete();
        await db.rounds.delete(roundId);
      });
      set({ items: get().items.filter((a) => a.id !== roundId) });
      emitArchiveChanged({ plotId: archive.plotId, reason: 'discard' });
    });
  },

  async toggleLock(roundId) {
    const current = await db.rounds.get(roundId);
    if (!current) throw new Error('期次档案不存在');
    const locked = !current.locked;
    let changed = 0;
    await db.transaction('rw', db.rounds, async () => {
      await db.rounds
        .where('id')
        .equals(roundId)
        .and((a) => a.version === current.version)
        .modify((a: RoundArchive) => {
          a.locked = locked;
          a.version = current.version + 1;
          // 已发布期：快照内的锁定标记同步补登，保证老档案读出来仍是当时状态
          if (a.snapshot) a.snapshot = { ...a.snapshot, locked };
          changed += 1;
        });
      if (changed === 0) throw new ArchiveConflictError();
    });
    const archive: RoundArchive = {
      ...current,
      locked,
      version: current.version + 1,
      snapshot: current.snapshot ? { ...current.snapshot, locked } : null,
    };
    set({ items: get().items.map((a) => (a.id === roundId ? archive : a)) });
    emitArchiveChanged({ plotId: current.plotId, reason: 'lock' });
    return archive;
  },

  async removeByPlot(plotId) {
    const ids = (await db.rounds.where('plotId').equals(plotId).toArray()).map((a) => a.id);
    await db.transaction('rw', db.rounds, db.trees, db.regens, db.rechecks, async () => {
      for (const rid of ids) {
        await db.trees.where('roundId').equals(rid).delete();
        await db.regens.where('roundId').equals(rid).delete();
        await db.rechecks.where('roundId').equals(rid).delete();
      }
      await db.rounds.where('plotId').equals(plotId).delete();
    });
    set({ items: get().items.filter((a) => a.plotId !== plotId) });
    emitArchiveChanged({ plotId, reason: 'remove' });
  },

  async bumpVersion(roundId, expectedVersion) {
    const updated = await db.rounds.update(roundId, { version: expectedVersion + 1 });
    if (updated === 0) throw new ArchiveConflictError();
    set({
      items: get().items.map((a) =>
        a.id === roundId ? { ...a, version: expectedVersion + 1 } : a,
      ),
    });
  },
}));

/** 取样地当前档案（有草稿取草稿，否则最近已发布） */
export function selectCurrentArchive(plotId: string): RoundArchive | undefined {
  const all = useRoundStore.getState().items.filter((a) => a.plotId === plotId);
  return draftOf(all) ?? latestPublishedOf(all);
}
