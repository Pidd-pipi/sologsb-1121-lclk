import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { plotSnapshotOf, type RoundArchive } from '../types/archive';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import { latestPublished } from '../utils/roundData';
import { usePlotStore } from './plotStore';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 操作结果：新建草稿或复用已有草稿（用于区分提示文案） */
export interface NextRoundResult {
  archive: RoundArchive;
  reused: boolean;
}

interface ArchiveState {
  items: RoundArchive[];
  loaded: boolean;
  /** 进行中的操作（key = 操作:plotId[:round]），按钮据此禁用，杜绝连点 */
  busy: Record<string, boolean>;
  load: () => Promise<void>;
  byPlot: (plotId: string) => RoundArchive[];
  /** 以最近一次已发布快照为底稿新开下一期；已有草稿时原样返回，不会多期 */
  startNextRound: (plotId: string, note?: string) => Promise<NextRoundResult>;
  /** 从已发布期生成修订期（新期号、草稿态），原快照保持不变 */
  startRevision: (plotId: string, sourceRound: number, note?: string) => Promise<RoundArchive>;
  /** 发布草稿：冻结当时的样木、更新层、复查结果与样地元信息；重复发布返回同一份 */
  publishDraft: (plotId: string, round: number) => Promise<RoundArchive>;
  /** 丢弃草稿及其底稿工作行 */
  discardDraft: (plotId: string, round: number) => Promise<void>;
}

/** 单飞：同一操作进行中时，连点只会等同一个 Promise */
const flights = new Map<string, Promise<unknown>>();

async function runGuarded<T>(flightKey: string, job: () => Promise<T>): Promise<T> {
  const inflight = flights.get(flightKey);
  if (inflight) return inflight as Promise<T>;
  const promise = (async () => {
    try {
      return await job();
    } finally {
      flights.delete(flightKey);
    }
  })();
  flights.set(flightKey, promise);
  return promise;
}

/** 同步样地当前期次（plotStore 静态依赖本模块，这里反向引用安全） */
async function syncPlotRound(plotId: string): Promise<void> {
  const plot = await db.plots.get(plotId);
  if (!plot) return;
  usePlotStore.setState((state) => ({
    items: state.items.map((p) => (p.id === plotId ? { ...p, surveyRound: plot.surveyRound } : p)),
  }));
}

async function findArchive(plotId: string, round: number): Promise<RoundArchive | undefined> {
  // 复合索引 [plotId+round]：每期唯一，Dexie 该重载的入参为宽松类型
  return db.archives
    .where('[plotId+round]')
    .equals([plotId, round] as unknown as never)
    .first();
}

export const useArchiveStore = create<ArchiveState>((set, get) => ({
  items: [],
  loaded: false,
  busy: {},

  async load() {
    const rows = await db.archives.toArray();
    rows.sort((a, b) => a.round - b.round);
    set({ items: rows, loaded: true });
  },

  byPlot(plotId) {
    return get()
      .items.filter((a) => a.plotId === plotId)
      .sort((a, b) => a.round - b.round);
  },

  async startNextRound(plotId, note) {
    const list = () => get().items.filter((a) => a.plotId === plotId);
    const existingDraft = list()
      .filter((a) => a.status === 'draft')
      .sort((a, b) => b.round - a.round)[0];
    if (existingDraft) {
      return { archive: existingDraft, reused: true };
    }
    const base = latestPublished(list());
    if (!base) {
      throw new Error('还没有已发布期次，请先发布当前期');
    }
    const newRound = Math.max(...list().map((a) => a.round)) + 1;
    const flightKey = `next:${plotId}`;
    set({ busy: { ...get().busy, [flightKey]: true } });
    try {
      const result = await runGuarded<NextRoundResult>(flightKey, async () => {
        const out = await db.transaction(
          'rw',
          db.archives,
          db.trees,
          db.plots,
          async (): Promise<NextRoundResult> => {
            // 事务内复查：两个终端并发时，先到的建草稿，后到的复用，绝不重复建期
            const fresh = await db.archives.where('plotId').equals(plotId).toArray();
            const freshDraft = fresh.find((a) => a.status === 'draft');
            if (freshDraft) return { archive: freshDraft, reused: true };
            if (fresh.some((a) => a.round === newRound)) {
              throw new Error(`第 ${newRound} 期档案已存在`);
            }

            const now = Date.now();
            // 底稿只从最近一次已发布快照拷贝（未发布草稿绝不混入）；采伐木不延续
            const carriedTrees: TreeRecord[] = base.trees
              .filter((t) => t.status !== '采伐')
              .map((t) => ({
                ...clone(t),
                id: newId('tree'),
                round: newRound,
                measuredAt: now,
              }));
            const draft: RoundArchive = {
              id: newId('arch'),
              plotId,
              round: newRound,
              status: 'draft',
              locked: false,
              createdAt: now,
              trees: clone(carriedTrees),
              regens: [],
              rechecks: [],
              note,
            };
            await db.trees.bulkPut(carriedTrees);
            await db.archives.put(draft);
            await db.plots.update(plotId, { surveyRound: newRound });
            return { archive: draft, reused: false };
          },
        );
        if (!out.reused) {
          set({ items: [...get().items, out.archive] });
          await syncPlotRound(plotId);
        } else {
          // 可能是另一终端刚写入的草稿：本地缓存补齐，避免两个终端显示不一致
          const tracked = get().items.some((a) => a.id === out.archive.id);
          if (!tracked) set({ items: [...get().items, out.archive] });
          await syncPlotRound(plotId);
        }
        return out;
      });
      return result;
    } finally {
      const next = { ...get().busy };
      delete next[flightKey];
      set({ busy: next });
    }
  },

  async startRevision(plotId, sourceRound, note) {
    const flightKey = `rev:${plotId}:${sourceRound}`;
    set({ busy: { ...get().busy, [flightKey]: true } });
    try {
      return await runGuarded<RoundArchive>(flightKey, async () => {
        const created = await db.transaction(
          'rw',
          db.archives,
          db.trees,
          db.regens,
          db.plots,
          async () => {
            const source = await findArchive(plotId, sourceRound);
            if (!source) throw new Error(`第 ${sourceRound} 期档案不存在`);
            if (source.status !== 'published') throw new Error('只能从已发布期生成修订期');
            const fresh = await db.archives.where('plotId').equals(plotId).toArray();
            // 连点/并发复查：同源修订已存在草稿时复用它，不再加期
            const existing = fresh.find(
              (a) => a.status === 'draft' && a.sourceArchiveId === source.id,
            );
            if (existing) return existing;
            const newRound = Math.max(...fresh.map((a) => a.round)) + 1;
            const now = Date.now();
            const trees: TreeRecord[] = source.trees.map((t) => ({
              ...clone(t),
              id: newId('tree'),
              round: newRound,
              measuredAt: now,
            }));
            const regens: RegenShrub[] = source.regens.map((r) => ({
              ...clone(r),
              id: newId('regen'),
              round: newRound,
            }));
            const draft: RoundArchive = {
              id: newId('arch'),
              plotId,
              round: newRound,
              status: 'draft',
              locked: false,
              createdAt: now,
              // 底稿副本：从原期快照复制，原快照一行不动
              trees: clone(trees),
              regens: clone(regens),
              rechecks: [],
              sourceRound,
              sourceArchiveId: source.id,
              note,
            };
            await db.trees.bulkPut(trees);
            await db.regens.bulkPut(regens);
            await db.archives.put(draft);
            await db.plots.update(plotId, { surveyRound: newRound });
            return draft;
          },
        );
        const alreadyTracked = get().items.some((a) => a.id === created.id);
        if (!alreadyTracked) set({ items: [...get().items, created] });
        await syncPlotRound(plotId);
        return created;
      });
    } finally {
      const next = { ...get().busy };
      delete next[flightKey];
      set({ busy: next });
    }
  },

  async publishDraft(plotId, round) {
    const flightKey = `pub:${plotId}:${round}`;
    set({ busy: { ...get().busy, [flightKey]: true } });
    try {
      return await runGuarded<RoundArchive>(flightKey, async () => {
        const published = await db.transaction(
          'rw',
          db.archives,
          db.trees,
          db.regens,
          db.rechecks,
          db.plots,
          async () => {
            const archive = await findArchive(plotId, round);
            if (!archive) throw new Error(`第 ${round} 期档案不存在`);
            if (archive.status === 'published') return archive; // 幂等：连点/重放直接返回原快照

            const plot = await db.plots.get(plotId);
            if (!plot) throw new Error('样地不存在');
            const [trees, regens, rechecks] = await Promise.all([
              db.trees.where('plotId').equals(plotId).filter((t) => t.round === round).toArray(),
              db.regens.where('plotId').equals(plotId).filter((r) => r.round === round).toArray(),
              db.rechecks
                .where('plotId')
                .equals(plotId)
                .filter((d) => d.targetRound === round)
                .toArray(),
            ]);
            const frozen: RoundArchive = {
              ...archive,
              status: 'published',
              locked: archive.locked,
              publishedAt: Date.now(),
              plotSnapshot: plotSnapshotOf(plot),
              trees: clone(trees),
              regens: clone(regens),
              rechecks: clone(rechecks),
            };
            await db.archives.put(frozen);
            return frozen;
          },
        );
        set({ items: get().items.map((a) => (a.id === published.id ? published : a)) });
        return published;
      });
    } finally {
      const next = { ...get().busy };
      delete next[flightKey];
      set({ busy: next });
    }
  },

  async discardDraft(plotId, round) {
    const flightKey = `discard:${plotId}:${round}`;
    set({ busy: { ...get().busy, [flightKey]: true } });
    try {
      await runGuarded<void>(flightKey, async () => {
        await db.transaction(
          'rw',
          db.archives,
          db.trees,
          db.regens,
          db.rechecks,
          db.plots,
          async () => {
            const archive = await findArchive(plotId, round);
            if (!archive) return;
            if (archive.status !== 'draft') throw new Error('已发布期次不能丢弃');
            await db.trees.where('plotId').equals(plotId).filter((t) => t.round === round).delete();
            await db.regens.where('plotId').equals(plotId).filter((r) => r.round === round).delete();
            await db.rechecks
              .where('plotId')
              .equals(plotId)
              .filter((d) => d.targetRound === round)
              .delete();
            await db.archives.delete(archive.id);
            // 当前期回落到最后一条档案（通常是最近已发布期）
            const remaining = (await db.archives.where('plotId').equals(plotId).toArray()).sort(
              (a, b) => a.round - b.round,
            );
            const fallback = remaining[remaining.length - 1];
            if (fallback) await db.plots.update(plotId, { surveyRound: fallback.round });
          },
        );
        set({ items: get().items.filter((a) => !(a.plotId === plotId && a.round === round)) });
        await syncPlotRound(plotId);
      });
    } finally {
      const next = { ...get().busy };
      delete next[flightKey];
      set({ busy: next });
    }
  },
}));
