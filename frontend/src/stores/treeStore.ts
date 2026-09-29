import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { TreeRecord, TreeRecordDraft } from '../types/tree';
import { ArchiveConflictError, ArchiveLockedError } from '../types/roundArchive';
import { useRoundStore } from './roundStore';
import { broadcastChange } from '../utils/dbSync';

interface TreeState {
  items: TreeRecord[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: TreeRecordDraft) => Promise<TreeRecord>;
  addMany: (drafts: TreeRecordDraft[]) => Promise<TreeRecord[]>;
  update: (id: string, patch: Partial<TreeRecord>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** 发布/修订等动作后由页面触发重载 */
  setItems: (items: TreeRecord[]) => void;
  byPlot: (plotId: string, round?: number) => TreeRecord[];
  byRound: (roundId: string) => TreeRecord[];
}

/**
 * 在事务内做条件写入（compare-and-swap）：
 * 只有当档案仍是草稿且乐观锁版本 == expected 时才允许写活动行并把版本 +1。
 * 两个终端/两个并发事务同时提交时，必有一方读到已被对方抬升的版本而失败，杜绝互相覆盖。
 */
async function writeWithLock(
  roundId: string,
  expected: number,
  write: () => Promise<void>,
): Promise<void> {
  await db.transaction('rw', db.trees, db.rounds, async () => {
    const fresh = await db.rounds.get(roundId);
    if (!fresh) throw new Error('期次档案不存在');
    if (fresh.status !== 'draft') throw new ArchiveLockedError();
    if (fresh.locked) throw new ArchiveLockedError('该期草稿已锁定，请先解锁再修改');
    if (fresh.version !== expected) throw new ArchiveConflictError();
    await write();
    const ok = await db.rounds.update(roundId, { version: expected + 1 });
    if (ok === 0) throw new ArchiveConflictError();
  });
}

/** 内存态守卫：提前给出友好错误，真正的并发安全靠事务内 CAS */
function requireWritableRound(roundId: string): { version: number } {
  const archive = useRoundStore.getState().getById(roundId);
  if (!archive) throw new Error('期次档案不存在');
  if (archive.status !== 'draft') throw new ArchiveLockedError();
  if (archive.locked) throw new ArchiveLockedError('该期草稿已锁定，请先解锁再修改');
  return { version: archive.version };
}

export const useTreeStore = create<TreeState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.trees.toArray();
    rows.sort((a, b) => a.round - b.round || a.treeNo.localeCompare(b.treeNo));
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const { version } = requireWritableRound(draft.roundId);
    const record: TreeRecord = { ...draft, id: newId('tree'), measuredAt: Date.now() };
    await writeWithLock(draft.roundId, version, async () => {
      await db.trees.put(record);
    });
    set({ items: [...get().items, record] });
    bumpLocalVersion(draft.roundId);
    return record;
  },
  async addMany(drafts) {
    const roundId = drafts[0]?.roundId;
    if (!roundId) return [];
    if (drafts.some((d) => d.roundId !== roundId)) throw new Error('不能跨期批量录入');
    const { version } = requireWritableRound(roundId);
    const records: TreeRecord[] = drafts.map((d) => ({
      ...d,
      id: newId('tree'),
      measuredAt: Date.now(),
    }));
    await writeWithLock(roundId, version, async () => {
      await db.trees.bulkPut(records);
    });
    set({ items: [...get().items, ...records] });
    bumpLocalVersion(roundId);
    return records;
  },
  async update(id, patch) {
    const existing = get().items.find((it) => it.id === id) ?? (await db.trees.get(id));
    if (!existing) return;
    const { version } = requireWritableRound(existing.roundId);
    await writeWithLock(existing.roundId, version, async () => {
      await db.trees.update(id, patch);
    });
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    bumpLocalVersion(existing.roundId);
  },
  async remove(id) {
    const existing = get().items.find((it) => it.id === id) ?? (await db.trees.get(id));
    if (!existing) return;
    const { version } = requireWritableRound(existing.roundId);
    await writeWithLock(existing.roundId, version, async () => {
      await db.trees.delete(id);
    });
    set({ items: get().items.filter((it) => it.id !== id) });
    bumpLocalVersion(existing.roundId);
  },
  setItems(items) {
    set({ items });
  },
  byPlot(plotId, round) {
    return get()
      .items.filter((it) => it.plotId === plotId && (round === undefined || it.round === round))
      .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
  },
  byRound(roundId) {
    return get()
      .items.filter((it) => it.roundId === roundId)
      .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
  },
}));

function bumpLocalVersion(roundId: string): void {
  useRoundStore.setState((s) => ({
    items: s.items.map((a) =>
      a.id === roundId && a.status === 'draft' ? { ...a, version: a.version + 1 } : a,
    ),
  }));
  broadcastChange({ table: 'trees' });
  broadcastChange({ table: 'rounds' });
}
