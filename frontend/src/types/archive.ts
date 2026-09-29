import type { Plot } from './plot';
import type { TreeRecord } from './tree';
import type { RegenShrub } from './regen';
import type { RecheckDiff } from './recheck';

/** 档案状态：草稿可编辑，发布后冻结 */
export type ArchiveStatus = 'draft' | 'published';

/** 发布时冻结的样地元信息 */
export type PlotSnapshot = Pick<
  Plot,
  | 'plotNo'
  | 'locality'
  | 'lng'
  | 'lat'
  | 'shape'
  | 'area'
  | 'elevation'
  | 'slope'
  | 'aspect'
  | 'forestType'
  | 'canopyDensity'
  | 'dominantSpecies'
  | 'surveyRound'
  | 'surveyedAt'
  | 'crew'
  | 'locked'
>;

/**
 * 期次档案：每个样地每期一条，[plotId + round] 唯一。
 *
 * - draft：未发布草稿（新开的下一期、或从已发布期生成的修订期），可继续录入，
 *   不参与「最近一次已发布快照」取值；
 * - published：发布时把当时的样木、更新层、逐株复查结果连同样地元信息一起冻结，
 *   之后不可修改；如需更正，只能从该期另开修订期（sourceRound 指回原期）。
 */
export interface RoundArchive {
  id: string;
  plotId: string;
  /** 期次号（修订期也占用新期号，保证每期只有一条档案） */
  round: number;
  status: ArchiveStatus;
  /** 原锁定状态，发布/补档时冻结 */
  locked: boolean;
  createdAt: number;
  /** 发布时间；「最近一次已发布」按它倒序取 */
  publishedAt?: number;
  /** 发布时冻结的样地元信息（草稿期可缺省） */
  plotSnapshot?: PlotSnapshot;
  /** 冻结的样木（修订/新开期时也是底稿工作行的初始副本） */
  trees: TreeRecord[];
  /** 冻结的更新苗 / 灌木 / 草本样方记录 */
  regens: RegenShrub[];
  /** 冻结的逐株复查比对结果（以 targetRound 归期） */
  rechecks: RecheckDiff[];
  /** 修订期：来源期次号；原始期为空 */
  sourceRound?: number;
  /** 修订期：来源档案 id */
  sourceArchiveId?: string;
  /** 修订原因等备注 */
  note?: string;
}

/** 从样地行摘取需要随期冻结的元信息 */
export function plotSnapshotOf(plot: Plot): PlotSnapshot {
  return {
    plotNo: plot.plotNo,
    locality: plot.locality,
    lng: plot.lng,
    lat: plot.lat,
    shape: plot.shape,
    area: plot.area,
    elevation: plot.elevation,
    slope: plot.slope,
    aspect: plot.aspect,
    forestType: plot.forestType,
    canopyDensity: plot.canopyDensity,
    dominantSpecies: plot.dominantSpecies,
    surveyRound: plot.surveyRound,
    surveyedAt: plot.surveyedAt,
    crew: plot.crew,
    locked: plot.locked,
  };
}
