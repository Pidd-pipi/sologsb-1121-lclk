import { useMemo } from 'react';
import { usePlotStore } from '../stores/plotStore';
import { useRegenStore } from '../stores/regenStore';
import { useTreeStore } from '../stores/treeStore';
import {
  avgDbh,
  avgHeight,
  basalAreaPerHectare,
  diameterDistribution,
  perHectareCount,
  regenDensity,
  totalBasalArea,
} from '../utils/forestCalc';
import type { RegenShrub } from '../types/regen';
import type { TreeRecord } from '../types/tree';

export interface TreeStats {
  /** 已录样木株数（本期） */
  count: number;
  aliveCount: number;
  /** 每公顷株数 */
  perHa: number;
  /** 平均胸径 cm */
  meanDbh: number;
  /** 平均树高 m */
  meanHeight: number;
  /** 断面积合计 m² */
  basalArea: number;
  /** 每公顷断面积 m²/hm² */
  basalAreaPerHa: number;
  /** 径阶分布 */
  diameterDist: { label: string; count: number }[];
  /** 更新密度 株/hm² */
  regenPerHa: number;
  /** 灌木密度 株/hm² */
  shrubPerHa: number;
  trees: TreeRecord[];
}

interface UseTreeStatsOptions {
  /** 指定期次档案：直接用给定行计算（已发布期传快照行） */
  trees?: TreeRecord[];
  regens?: RegenShrub[];
}

/**
 * 算每公顷株数、平均胸径、断面积与径阶分布。
 * 被林分因子汇总页（/summary/:plotId）与样木录入页消费。
 * 传 roundId 时按档案取数；传 options.trees/regens 时直接消费快照。
 */
export function useTreeStats(
  plotId: string | undefined,
  round?: number,
  roundId?: string,
  options?: UseTreeStatsOptions,
): TreeStats {
  const plots = usePlotStore((s) => s.items);
  const allTrees = useTreeStore((s) => s.items);
  const regenRows = useRegenStore((s) => s.items);

  const plot = plots.find((p) => p.id === plotId);
  const targetRound = round ?? plot?.surveyRound ?? 1;

  return useMemo<TreeStats>(() => {
    const trees = (options?.trees ??
      (roundId
        ? allTrees.filter((t) => t.roundId === roundId)
        : allTrees.filter((t) => t.plotId === plotId && t.round === targetRound)))
      .slice()
      .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
    const alive = trees.filter((t) => t.status === '活立木');
    const area = plot?.area ?? 0;
    const plotRegens =
      options?.regens ??
      (roundId
        ? regenRows.filter((r) => r.roundId === roundId)
        : regenRows.filter((r) => r.plotId === plotId && r.round === targetRound));

    return {
      count: trees.length,
      aliveCount: alive.length,
      perHa: perHectareCount(alive.length, area),
      meanDbh: avgDbh(trees),
      meanHeight: avgHeight(trees),
      basalArea: totalBasalArea(trees),
      basalAreaPerHa: basalAreaPerHectare(trees, area),
      diameterDist: diameterDistribution(trees),
      regenPerHa: plot ? regenDensity(plotRegens, plot, '更新苗') : 0,
      shrubPerHa: plot ? regenDensity(plotRegens, plot, '灌木') : 0,
      trees,
    };
  }, [allTrees, regenRows, plotId, targetRound, plot, roundId, options?.trees, options?.regens]);
}
