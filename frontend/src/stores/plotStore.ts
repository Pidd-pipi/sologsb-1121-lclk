import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { Plot, PlotDraft } from '../types/plot';
import { useRoundStore } from './roundStore';
import { draftOf, latestPublishedOf, sortArchives } from '../types/roundArchive';
import { broadcastChange } from '../utils/dbSync';

interface PlotState {
  items: Plot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PlotDraft) => Promise<Plot>;
  update: (id: string, patch: Partial<Plot>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** 档案变化后把 surveyRound / locked 回写到样地（供旧筛选与角标消费） */
  syncFromArchives: (plotId: string) => Promise<void>;
}

export const usePlotStore = create<PlotState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.plots.orderBy('createdAt').reverse().toArray();
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const plotId = newId('plot');
    const roundId = newId('round');
    const record: Plot = { ...draft, id: plotId, createdAt: now };
    const round = {
      id: roundId,
      plotId,
      roundNo: Math.max(1, draft.surveyRound || 1),
      revisionSeq: 0,
      status: 'draft' as const,
      version: 1,
      sourceRoundId: null,
      originRoundId: null,
      baseRoundId: null,
      locked: false,
      createdAt: now,
      publishedAt: null,
      snapshot: null,
    };
    // 样地与第 1 期草稿同事务落地：连续点两次保存也不会出现无档案样地或重复草稿
    await db.transaction('rw', db.plots, db.rounds, async () => {
      await db.plots.put(record);
      await db.rounds.put(round);
    });
    useRoundStore.setState({ items: sortArchives([...useRoundStore.getState().items, round]) });
    set({ items: [record, ...get().items] });
    broadcastChange({ table: 'plots' });
    broadcastChange({ table: 'rounds' });
    return record;
  },
  async update(id, patch) {
    await db.plots.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async remove(id) {
    await useRoundStore.getState().removeByPlot(id);
    await db.plots.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
    broadcastChange({ table: 'plots' });
  },
  async syncFromArchives(plotId) {
    const plot = get().items.find((it) => it.id === plotId);
    if (!plot) return;
    const archives = useRoundStore.getState().byPlot(plotId);
    const current = draftOf(archives) ?? latestPublishedOf(archives);
    if (!current) return;
    const patch: Partial<Plot> = {
      surveyRound: current.roundNo,
      locked: current.locked && current.status !== 'draft' ? current.locked : current.locked,
    };
    await db.plots.update(plotId, patch);
    set({ items: get().items.map((it) => (it.id === plotId ? { ...it, ...patch } : it)) });
  },
}));
