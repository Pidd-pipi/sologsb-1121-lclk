import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { RegenShrub, RegenShrubDraft } from '../types/regen';
import { ArchiveConflictError, ArchiveLockedError } from '../types/roundArchive';
import { useRoundStore } from './roundStore';
import { broadcastChange } from '../utils/dbSync';

interface RegenState {
  items: RegenShrub[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: RegenShrubDraft) => Promise<RegenShrub>;
  update: (id: string, patch: Partial<RegenShrub>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setItems: (items: RegenShrub[]) => void;
  byPlot: (plotId: string, round?: number) => RegenShrub[];
  byRound: (roundId: string) => RegenShrub[];
}

/** 同 treeStore：事务内 CAS，版本不匹配即失败，防止两个终端互相覆盖 */
async function writeWithLock(
  roundId: string,
  expected: number,
  write: () => Promise<void>,
): Promise<void> {
  await db.transaction('rw', db.regens, db.rounds, async () => {
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

function requireWritableRound(roundId: string): { version: number } {
  const archive = useRoundStore.getState().getById(roundId);
  if (!archive) throw new Error('期次档案不存在');
  if (archive.status !== 'draft') throw new ArchiveLockedError();
  if (archive.locked) throw new ArchiveLockedError('该期草稿已锁定，请先解锁再修改');
  return { version: archive.version };
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
    const { version } = requireWritableRound(draft.roundId);
    const record: RegenShrub = { ...draft, id: newId('regen') };
    await writeWithLock(draft.roundId, version, async () => {
      await db.regens.put(record);
    });
    set({ items: [...get().items, record] });
    bumpLocalVersion(draft.roundId);
    return record;
  },
  async update(id, patch) {
    const existing = get().items.find((it) => it.id === id) ?? (await db.regens.get(id));
    if (!existing) return;
    const { version } = requireWritableRound(existing.roundId);
    await writeWithLock(existing.roundId, version, async () => {
      await db.regens.update(id, patch);
    });
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    bumpLocalVersion(existing.roundId);
  },
  async remove(id) {
    const existing = get().items.find((it) => it.id === id) ?? (await db.regens.get(id));
    if (!existing) return;
    const { version } = requireWritableRound(existing.roundId);
    await writeWithLock(existing.roundId, version, async () => {
      await db.regens.delete(id);
    });
    set({ items: get().items.filter((it) => it.id !== id) });
    bumpLocalVersion(existing.roundId);
  },
  setItems(items) {
    set({ items });
  },
  byPlot(plotId, round) {
    return get().items.filter(
      (it) => it.plotId === plotId && (round === undefined || it.round === round),
    );
  },
  byRound(roundId) {
    return get().items.filter((it) => it.roundId === roundId);
  },
}));

function bumpLocalVersion(roundId: string): void {
  useRoundStore.setState((s) => ({
    items: s.items.map((a) =>
      a.id === roundId && a.status === 'draft' ? { ...a, version: a.version + 1 } : a,
    ),
  }));
  broadcastChange({ table: 'regens' });
  broadcastChange({ table: 'rounds' });
}
