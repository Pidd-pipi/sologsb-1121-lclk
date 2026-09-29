import { useCallback, useMemo } from 'react';
import { useRoundStore } from '../stores/roundStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import { usePlotStore } from '../stores/plotStore';
import {
  currentArchiveOf,
  sortArchives,
  type RoundArchive,
  type SnapshotRegen,
  type SnapshotTree,
} from '../types/roundArchive';
import type { RegenShrub } from '../types/regen';
import type { TreeRecord } from '../types/tree';

/** 把快照行映射成带稳定伪主键的只读行（TreeTable 依赖 rowKey） */
export function snapshotTrees(archive: RoundArchive): TreeRecord[] {
  return (archive.snapshot?.trees ?? []).map((t: SnapshotTree, i) => ({
    ...t,
    id: `snap-tree:${archive.id}:${i}`,
    plotId: archive.plotId,
    roundId: archive.id,
  }));
}

export function snapshotRegens(archive: RoundArchive): RegenShrub[] {
  return (archive.snapshot?.regens ?? []).map((r: SnapshotRegen, i) => ({
    ...r,
    id: `snap-regen:${archive.id}:${i}`,
    plotId: archive.plotId,
    roundId: archive.id,
  }));
}

export interface ArchiveData {
  archives: RoundArchive[];
  /** 当前档案：有草稿取草稿，否则取最近已发布快照 */
  current: RoundArchive | undefined;
  draft: RoundArchive | undefined;
  /** 当前期可见样木（草稿=活动行，已发布=快照，未发布草稿不会从别的期混入） */
  trees: TreeRecord[];
  regens: RegenShrub[];
  /** 当前期是否只读 */
  readOnly: boolean;
}

/** 样地期次档案与当前期数据的统一入口 */
export function useArchiveData(plotId: string): ArchiveData {
  const archivesAll = useRoundStore((s) => s.items);
  const liveTrees = useTreeStore((s) => s.items);
  const liveRegens = useRegenStore((s) => s.items);

  return useMemo<ArchiveData>(() => {
    const archives = sortArchives(archivesAll.filter((a) => a.plotId === plotId));
    const current = currentArchiveOf(archives);
    const draft = archives.find((a) => a.status === 'draft');
    if (!current) {
      return { archives, current: undefined, draft: undefined, trees: [], regens: [], readOnly: true };
    }
    const readOnly = current.status !== 'draft';
    const trees = readOnly
      ? snapshotTrees(current)
      : liveTrees
          .filter((t) => t.roundId === current.id)
          .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
    const regens = readOnly
      ? snapshotRegens(current)
      : liveRegens.filter((r) => r.roundId === current.id);
    return { archives, current, draft, trees, regens, readOnly };
  }, [archivesAll, liveTrees, liveRegens, plotId]);
}

/** 档案结构变化（发布 / 开新期 / 修订 / 锁定）后重载所有相关表 */
export function useReloadAfterRoundChange() {
  return useCallback(async (plotId: string) => {
    await Promise.all([
      useRoundStore.getState().load(),
      useTreeStore.getState().load(),
      useRegenStore.getState().load(),
    ]);
    await usePlotStore.getState().syncFromArchives(plotId);
  }, []);
}
