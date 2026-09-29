import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { RegenShrub, RegenShrubDraft } from '../types/regen';
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

interface RegenState {
  items: RegenShrub[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: RegenShrubDraft) => Promise<RegenShrub>;
  update: (id: string, patch: Partial<RegenShrub>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byPlot: (plotId: string, round?: number) => RegenShrub[];
}

export const useRegenStore = create<RegenState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.regens.toArray();
    rows.sort((a, b) => a.round - b.round || a.layer.localeCompare(b.layer));
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    assertRoundWritable(draft.plotId, draft.round);
    const record: RegenShrub = { ...draft, id: newId('regen') };
    await db.regens.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async update(id, patch) {
    const current = get().items.find((it) => it.id === id);
    if (current) assertRoundWritable(current.plotId, patch.round ?? current.round);
    await db.regens.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async remove(id) {
    const current = get().items.find((it) => it.id === id);
    if (current) assertRoundWritable(current.plotId, current.round);
    await db.regens.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  byPlot(plotId, round) {
    return get().items.filter((it) => it.plotId === plotId && (round === undefined || it.round === round));
  },
}));
