import type { Plot } from '../types/plot';
import type { RegenShrub } from '../types/regen';
import type { TreeRecord } from '../types/tree';
import {
  avgDbh,
  avgHeight,
  basalAreaPerHectare,
  diameterDistribution,
  perHectareCount,
  regenDensity,
  totalBasalArea,
} from './forestCalc';

export interface RoundStats {
  /** 该期样木株数 */
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

/** 林分计算只需面积（其余样地字段不参与），已发布快照与实时样地都满足 */
export type AreaSource = Pick<Plot, 'area'>;

/** 由某期样木/样方数据计算林分因子（useTreeStats 与档案快照页共用） */
export function computeRoundStats(treesIn: TreeRecord[], regensIn: RegenShrub[], plot?: AreaSource): RoundStats {
  const trees = [...treesIn].sort((a, b) =>
    a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }),
  );
  const alive = trees.filter((t) => t.status === '活立木');
  const area = plot?.area ?? 0;
  return {
    count: trees.length,
    aliveCount: alive.length,
    perHa: perHectareCount(alive.length, area),
    meanDbh: avgDbh(trees),
    meanHeight: avgHeight(trees),
    basalArea: totalBasalArea(trees),
    basalAreaPerHa: basalAreaPerHectare(trees, area),
    diameterDist: diameterDistribution(trees),
    regenPerHa: plot ? regenDensity(regensIn, plot, '更新苗') : 0,
    shrubPerHa: plot ? regenDensity(regensIn, plot, '灌木') : 0,
    trees,
  };
}
