import type { RoundArchive } from '../types/archive';
import type { RecheckDiff } from '../types/recheck';
import type { RegenShrub } from '../types/regen';
import type { TreeRecord } from '../types/tree';

/** 按期次号升序排列的档案 */
export function sortArchives(list: RoundArchive[]): RoundArchive[] {
  return [...list].sort((a, b) => a.round - b.round);
}

export function archiveOf(list: RoundArchive[], round: number): RoundArchive | undefined {
  return list.find((a) => a.round === round);
}

/** 最近一次已发布档案：按发布时间倒序（修订旧期时也能成为最新依据），同期再按期号 */
export function latestPublished(list: RoundArchive[]): RoundArchive | undefined {
  return list
    .filter((a) => a.status === 'published')
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0) || b.round - a.round)[0];
}

/** 当前草稿（理论上每期唯一；多草稿时取期号最大的一条） */
export function draftArchive(list: RoundArchive[]): RoundArchive | undefined {
  return list
    .filter((a) => a.status === 'draft')
    .sort((a, b) => b.round - a.round)[0];
}

/**
 * 取某期的权威样木：已发布期读快照（旧行后续被改也不影响档案），
 * 草稿期读实时工作表（archive 内的 trees 只作底稿副本）。
 */
export function treesOfRound(
  archives: RoundArchive[],
  workingTrees: TreeRecord[],
  plotId: string,
  round: number,
): TreeRecord[] {
  const archive = archiveOf(archives, round);
  const source = archive?.status === 'published' ? archive.trees : workingTrees;
  return source
    .filter((t) => t.plotId === plotId && t.round === round)
    .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
}

export function regensOfRound(
  archives: RoundArchive[],
  workingRegens: RegenShrub[],
  plotId: string,
  round: number,
): RegenShrub[] {
  const archive = archiveOf(archives, round);
  const source = archive?.status === 'published' ? archive.regens : workingRegens;
  return source.filter((r) => r.plotId === plotId && r.round === round);
}

export function rechecksOfRound(
  archives: RoundArchive[],
  workingRechecks: RecheckDiff[],
  plotId: string,
  round: number,
): RecheckDiff[] {
  const archive = archiveOf(archives, round);
  const source = archive?.status === 'published' ? archive.rechecks : workingRechecks;
  return source
    .filter((d) => d.plotId === plotId && d.targetRound === round)
    .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
}
