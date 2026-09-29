import type { TreeRecord } from './tree';
import type { RegenShrub } from './regen';
import type { RecheckDiff } from './recheck';

/** 档案状态：草稿 / 原期已发布 / 修订期已发布 */
export type RoundStatus = 'draft' | 'published' | 'revision';

/** 快照中的样木（去掉归属与主键，只保留当时测到的事实） */
export type SnapshotTree = Omit<TreeRecord, 'id' | 'plotId' | 'roundId'>;
/** 快照中的更新层样方记录 */
export type SnapshotRegen = Omit<RegenShrub, 'id' | 'plotId' | 'roundId'>;
/** 快照中的两期复查比对结果 */
export type SnapshotDiff = Omit<RecheckDiff, 'id' | 'plotId' | 'roundId'>;

/** 发布时定格的一期档案内容 */
export interface RoundSnapshot {
  /** 当时的样木 */
  trees: SnapshotTree[];
  /** 当时的更新苗 / 灌木 / 草本层 */
  regens: SnapshotRegen[];
  /** 当时保存的复查比对结果 */
  diffs: SnapshotDiff[];
  /** 发布时的锁定标记（原样留存） */
  locked: boolean;
  /** 定格时间 */
  savedAt: number;
}

/**
 * 期次档案：一期调查数据的可发布、可追溯单元。
 * - draft：未发布草稿，可增删改；只有一份，且下一期不会以它为准。
 * - published：原期发布后只读，任何再修改都必须另起修订期。
 * - revision：由某份已发布档案派生的修订期，sourceRoundId 标明来源。
 */
export interface RoundArchive {
  id: string;
  plotId: string;
  /** 期号（同一样地内，修订期沿用原期号） */
  roundNo: number;
  /** 同一期号第几次修订，原期为 0 */
  revisionSeq: number;
  status: RoundStatus;
  /** 乐观锁版本：草稿每保存一次 +1，发布时再 +1 */
  version: number;
  /** 修订期的来源档案 id；原期为 null */
  sourceRoundId: string | null;
  /** 修订链上的最初原期 id；原期为 null */
  originRoundId: string | null;
  /** 本期的比对基线（上一期档案）id */
  baseRoundId: string | null;
  /** 锁定标记（迁移自旧版 plot.locked / 发布时状态） */
  locked: boolean;
  createdAt: number;
  publishedAt: number | null;
  /** 发布快照；草稿期为 null */
  snapshot: RoundSnapshot | null;
}

/** 样地内最多保留一份未发布草稿 */
export function draftOf(archives: RoundArchive[]): RoundArchive | undefined {
  return archives.find((a) => a.status === 'draft');
}

/** 最近一次已发布快照（按期号、修订次序、发布时间取最新） */
export function latestPublishedOf(archives: RoundArchive[]): RoundArchive | undefined {
  return archives
    .filter((a) => a.status !== 'draft' && a.snapshot)
    .sort(
      (a, b) =>
        b.roundNo - a.roundNo ||
        b.revisionSeq - a.revisionSeq ||
        (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
    )[0];
}

/** 当前生效期次：有草稿取草稿，否则取最近已发布档案 */
export function currentArchiveOf(archives: RoundArchive[]): RoundArchive | undefined {
  return draftOf(archives) ?? latestPublishedOf(archives);
}

/** 按期号、修订次序排列 */
export function sortArchives(archives: RoundArchive[]): RoundArchive[] {
  return [...archives].sort(
    (a, b) => a.roundNo - b.roundNo || a.revisionSeq - b.revisionSeq || a.createdAt - b.createdAt,
  );
}

/** 档案展示名，如「第 2 期」「第 2 期 · 修订 1」 */
export function roundArchiveLabel(a: Pick<RoundArchive, 'roundNo' | 'revisionSeq' | 'status'>): string {
  const base = `第 ${a.roundNo} 期`;
  return a.status === 'draft'
    ? `${base} · 草稿`
    : a.revisionSeq > 0
      ? `${base} · 修订 ${a.revisionSeq}`
      : base;
}

export function toSnapshotTree(t: TreeRecord): SnapshotTree {
  const { id: _id, plotId: _plotId, roundId: _roundId, ...rest } = t;
  return { ...rest };
}

export function toSnapshotRegen(r: RegenShrub): SnapshotRegen {
  const { id: _id, plotId: _plotId, roundId: _roundId, ...rest } = r;
  return { ...rest };
}

export function toSnapshotDiff(d: RecheckDiff): SnapshotDiff {
  const { id: _id, plotId: _plotId, roundId: _roundId, ...rest } = d;
  return { ...rest };
}

/** 档案被其他终端改动、乐观锁版本不匹配 */
export class ArchiveConflictError extends Error {
  constructor(message = '该期档案已被其他终端提交，请刷新后以最新版本重试') {
    super(message);
    this.name = 'ArchiveConflictError';
  }
}

/** 已发布档案只读 */
export class ArchiveLockedError extends Error {
  constructor(message = '该期已发布归档，不能直接修改；请从原期生成修订期') {
    super(message);
    this.name = 'ArchiveLockedError';
  }
}
