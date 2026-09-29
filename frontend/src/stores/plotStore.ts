import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { Plot, PlotDraft } from '../types/plot';
import type { RoundArchive } from '../types/archive';
import { useArchiveStore } from './archiveStore';

interface PlotState {
  items: Plot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PlotDraft) => Promise<Plot>;
  update: (id: string, patch: Partial<Plot>) => Promise<void>;
  toggleLock: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const usePlotStore = create<PlotState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.plots.orderBy('createdAt').reverse().toArray();
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const id = newId('plot');
    const createdAt = Date.now();
    const record: Plot = { ...draft, id, createdAt };
    // 建档即开第 1 期（或指定期次）草稿；未发布不会污染任何历史快照
    const firstRound = draft.surveyRound > 0 ? draft.surveyRound : 1;
    const roundArchive: RoundArchive = {
      id: newId('arch'),
      plotId: id,
      round: firstRound,
      status: 'draft',
      locked: false,
      createdAt,
      trees: [],
      regens: [],
      rechecks: [],
    };
    await db.transaction('rw', db.plots, db.archives, async () => {
      await db.plots.put(record);
      await db.archives.put(roundArchive);
    });
    useArchiveStore.setState((state) => ({ items: [...state.items, roundArchive] }));
    set({ items: [record, ...get().items] });
    return record;
  },
  async update(id, patch) {
    await db.plots.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async toggleLock(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    await get().update(id, { locked: !target.locked });
  },
  async remove(id) {
    await db.transaction(
      'rw',
      db.plots,
      db.trees,
      db.regens,
      db.rechecks,
      db.archives,
      async () => {
        await db.trees.where('plotId').equals(id).delete();
        await db.regens.where('plotId').equals(id).delete();
        await db.rechecks.where('plotId').equals(id).delete();
        await db.archives.where('plotId').equals(id).delete();
        await db.plots.delete(id);
      },
    );
    useArchiveStore.setState((state) => ({ items: state.items.filter((a) => a.plotId !== id) }));
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
