import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { TreeRecord, TreeRecordDraft } from '../types/tree';
import { useArchiveStore } from './archiveStore';

/** 已发布期档案不可变：修改请从原期生成修订期 */
function assertRoundWritable(plotId: string, round: number): void {
  const archive = useArchiveStore
    .getState()
    .items.find((a) => a.plotId === plotId && a.round === round);
  if (archive?.status === 'published') {
    throw new Error(`第 ${round} 期已发布归档，不能修改；请从该期生成修订期`);
  }
}

interface TreeState {
  items: TreeRecord[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: TreeRecordDraft) => Promise<TreeRecord>;
  addMany: (drafts: TreeRecordDraft[]) => Promise<TreeRecord[]>;
  update: (id: string, patch: Partial<TreeRecord>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byPlot: (plotId: string, round?: number) => TreeRecord[];
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
    assertRoundWritable(draft.plotId, draft.round);
    const record: TreeRecord = { ...draft, id: newId('tree'), measuredAt: Date.now() };
    await db.trees.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async addMany(drafts) {
    drafts.forEach((d) => assertRoundWritable(d.plotId, d.round));
    const records: TreeRecord[] = drafts.map((d) => ({
      ...d,
      id: newId('tree'),
      measuredAt: Date.now(),
    }));
    await db.trees.bulkPut(records);
    set({ items: [...get().items, ...records] });
    return records;
  },
  async update(id, patch) {
    const current = get().items.find((it) => it.id === id);
    if (current) assertRoundWritable(current.plotId, patch.round ?? current.round);
    await db.trees.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async remove(id) {
    const current = get().items.find((it) => it.id === id);
    if (current) assertRoundWritable(current.plotId, current.round);
    await db.trees.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  byPlot(plotId, round) {
    return get()
      .items.filter((it) => it.plotId === plotId && (round === undefined || it.round === round))
      .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
  },
}));
