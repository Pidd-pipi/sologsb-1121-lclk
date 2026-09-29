import type { RecheckDiff } from '../types/recheck';
import type { TreeRecord } from '../types/tree';
import { newId } from './id';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 由上下两期样木生成逐株比对表（纯函数，复查页与灌档种子数据共用）。
 * 缺失行：本期未复测 → 疑似采伐或倒伏；只有本期 → 新增进界木。
 */
export function buildRecheckDiffs(
  plotId: string,
  baseRound: number,
  targetRound: number,
  baseTrees: TreeRecord[],
  targetTrees: TreeRecord[],
  now = Date.now(),
): RecheckDiff[] {
  const baseMap = new Map<string, TreeRecord>();
  baseTrees.forEach((t) => baseMap.set(t.treeNo, t));
  const targetMap = new Map<string, TreeRecord>();
  targetTrees.forEach((t) => targetMap.set(t.treeNo, t));
  const allNos = Array.from(new Set([...baseMap.keys(), ...targetMap.keys()])).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN', { numeric: true }),
  );

  return allNos.map((treeNo) => {
    const b = baseMap.get(treeNo);
    const t = targetMap.get(treeNo);
    const baseDbh = b?.dbhCm;
    const targetDbh = t?.dbhCm;
    const dbhGrowth = baseDbh !== undefined && targetDbh !== undefined ? r2(targetDbh - baseDbh) : 0;
    const heightGrowth = b && t ? r2(t.heightM - b.heightM) : 0;
    const statusChange = b && t && b.status !== t.status ? `${b.status} → ${t.status}` : '';
    const missingReason = !t ? '本期未复测（疑似采伐或倒伏）' : !b ? '本期新增进界木' : '';
    return {
      id: newId('diff'),
      plotId,
      baseRound,
      targetRound,
      treeNo,
      species: t?.species ?? b?.species ?? '',
      baseDbhCm: baseDbh,
      targetDbhCm: targetDbh,
      baseHeightM: b?.heightM,
      targetHeightM: t?.heightM,
      dbhGrowth,
      heightGrowth,
      statusChange,
      missingReason,
      generatedAt: now,
    };
  });
}
