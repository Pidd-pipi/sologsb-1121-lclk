import { useMemo } from 'react';
import { usePlotStore } from '../stores/plotStore';
import { useRegenStore } from '../stores/regenStore';
import { useTreeStore } from '../stores/treeStore';
import { useArchiveStore } from '../stores/archiveStore';
import { computeRoundStats, type AreaSource, type RoundStats } from '../utils/stats';
import { regensOfRound, treesOfRound } from '../utils/roundData';

export type TreeStats = RoundStats;

/**
 * 算某期每公顷株数、平均胸径、断面积与径阶分布。
 * 已发布期以冻结快照为准，草稿期读实时工作数据。
 * 被林分因子汇总页（/summary/:plotId）与样木录入页消费。
 */
export function useTreeStats(plotId: string | undefined, round?: number): TreeStats {
  const plots = usePlotStore((s) => s.items);
  const allTrees = useTreeStore((s) => s.items);
  const regens = useRegenStore((s) => s.items);
  const archives = useArchiveStore((s) => s.items);

  const plot = plots.find((p) => p.id === plotId);
  const archive = archives.find((a) => a.plotId === plotId && a.round === round);
  const targetRound = round ?? plot?.surveyRound ?? 1;

  return useMemo<TreeStats>(() => {
    const roundTrees = treesOfRound(archives, allTrees, plotId ?? '', targetRound);
    const roundRegens = regensOfRound(archives, regens, plotId ?? '', targetRound);
    // 已发布期的面积等元信息也以快照为准
    const areaSource: AreaSource | undefined =
      archive?.status === 'published' ? archive.plotSnapshot : plot;
    return computeRoundStats(roundTrees, roundRegens, areaSource);
  }, [archives, allTrees, regens, plotId, targetRound, archive, plot]);
}
