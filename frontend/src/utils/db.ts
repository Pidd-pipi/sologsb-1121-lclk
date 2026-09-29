import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import { plotSnapshotOf, type RoundArchive } from '../types/archive';
import { newId } from './id';
import { buildRecheckDiffs } from './recheck';

export const DB_NAME = 'gbforestplot';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbforestplot:db-version';

class ForestPlotDB extends Dexie {
  plots!: Table<Plot, string>;
  trees!: Table<TreeRecord, string>;
  regens!: Table<RegenShrub, string>;
  rechecks!: Table<RecheckDiff, string>;
  archives!: Table<RoundArchive, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, createdAt',
      trees: 'id, plotId, treeNo, species, round, status',
      regens: 'id, plotId, layer, species, round',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo',
    });
    this.version(2)
      .stores({
        plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
        trees: 'id, plotId, treeNo, species, round, status, measuredAt',
        regens: 'id, plotId, layer, species, round, heightCm',
        rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('plots')
          .toCollection()
          .modify((row: any) => {
            if (row.locked === undefined) row.locked = false;
            if (row.surveyRound === undefined) row.surveyRound = 1;
          });
        await tx
          .table('trees')
          .toCollection()
          .modify((row: any) => {
            if (row.round === undefined) row.round = 1;
            if (row.measuredAt === undefined) row.measuredAt = Date.now();
          });
      });
    this.version(3)
      .stores({
        plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
        trees: 'id, plotId, treeNo, species, round, status, measuredAt',
        regens: 'id, plotId, layer, species, round, heightCm',
        rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
        // 每个样地每期只能有一条档案（&[plotId+round] 唯一索引兜底并发写入）
        archives: 'id, plotId, round, status, &[plotId+round], publishedAt',
      })
      .upgrade(async (tx) => {
        // 旧档案升级：按历史轮次补齐发布快照；原 locked 与两期比对结果原样保留
        const [plots, trees, regens, rechecks] = await Promise.all([
          tx.table('plots').toCollection().toArray() as Promise<Plot[]>,
          tx.table('trees').toCollection().toArray() as Promise<TreeRecord[]>,
          tx.table('regens').toCollection().toArray() as Promise<RegenShrub[]>,
          tx.table('rechecks').toCollection().toArray() as Promise<RecheckDiff[]>,
        ]);
        const now = Date.now();
        const day = 24 * 3600 * 1000;
        const archives: RoundArchive[] = [];

        for (const plot of plots) {
          const plotTrees = trees.filter((t) => t.plotId === plot.id);
          const plotRegens = regens.filter((r) => r.plotId === plot.id);
          const plotRechecks = rechecks.filter((d) => d.plotId === plot.id);
          const rounds = new Set<number>();
          plotTrees.forEach((t) => rounds.add(t.round));
          plotRegens.forEach((r) => rounds.add(r.round));
          plotRechecks.forEach((d) => rounds.add(d.targetRound));

          if (rounds.size === 0) {
            // 只有样地、没有任何期数据：补一个第 1 期草稿，让后续可以直接录入再发布
            const round = Math.max(1, plot.surveyRound || 1);
            archives.push({
              id: newId('arch'),
              plotId: plot.id,
              round,
              status: 'draft',
              locked: false,
              createdAt: plot.createdAt ?? now,
              trees: [],
              regens: [],
              rechecks: [],
            });
            continue;
          }

          const ordered = Array.from(rounds).sort((a, b) => a - b);
          ordered.forEach((round, index) => {
            archives.push({
              id: newId('arch'),
              plotId: plot.id,
              round,
              status: 'published',
              // 锁定标记原样保留：样地锁定且该期早于当前期 → 往期锁定
              locked: !!plot.locked && round < plot.surveyRound,
              createdAt: now - (ordered.length - index) * 30 * day,
              publishedAt: now - (ordered.length - 1 - index) * 30 * day,
              plotSnapshot: plotSnapshotOf(plot),
              trees: plotTrees.filter((t) => t.round === round).map((t) => ({ ...t })),
              regens: plotRegens.filter((r) => r.round === round).map((r) => ({ ...r })),
              // 两期比对结果按「本期（targetRound）」归入对应快照
              rechecks: plotRechecks.filter((d) => d.targetRound === round).map((d) => ({ ...d })),
            });
          });

          // 当前期次没有任何历史数据时，补一个空草稿，避免升级后「下一期」无草稿可录
          const maxRound = ordered[ordered.length - 1];
          if (plot.surveyRound > maxRound) {
            archives.push({
              id: newId('arch'),
              plotId: plot.id,
              round: plot.surveyRound,
              status: 'draft',
              locked: false,
              createdAt: now,
              trees: [],
              regens: [],
              rechecks: [],
            });
          }
        }

        if (archives.length > 0) await tx.table('archives').bulkPut(archives);
      });
  }
}

export const db = new ForestPlotDB();

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 保存草稿期的逐株比对结果（整组覆盖同期旧结果，避免连点堆积） */
export async function replaceRecheckDiffs(plotId: string, targetRound: number, diffs: RecheckDiff[]): Promise<void> {
  await db.transaction('rw', db.rechecks, async () => {
    await db.rechecks.where('plotId').equals(plotId).filter((d) => d.targetRound === targetRound).delete();
    if (diffs.length > 0) await db.rechecks.bulkPut(diffs);
  });
}

export async function loadRecheckDiffs(plotId: string, targetRound?: number): Promise<RecheckDiff[]> {
  let rows = await db.rechecks.where('plotId').equals(plotId).toArray();
  if (targetRound !== undefined) rows = rows.filter((d) => d.targetRound === targetRound);
  return rows.sort((a, b) => a.treeNo.localeCompare(b.treeNo));
}

/** 首次进入灌入示范样地与两期样木数据 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.plots.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const plotId = newId('plot');
  const plot2Id = newId('plot');

  const plots: Plot[] = [
    {
      id: plotId,
      plotNo: 'FP-4102',
      locality: '黑龙江凉水林场 12 林班',
      lng: 128.8934,
      lat: 47.1832,
      shape: '方形',
      area: 600,
      elevation: 412,
      slope: 8,
      aspect: '东南',
      forestType: '针阔混交林',
      canopyDensity: 0.72,
      dominantSpecies: '红松 + 紫椴',
      surveyRound: 2,
      surveyedAt: now - 6 * day,
      crew: '调查一组（顾青、李慕）',
      locked: true,
      createdAt: now - 400 * day,
    },
    {
      id: plot2Id,
      plotNo: 'FP-4115',
      locality: '黑龙江凉水林场 15 林班',
      lng: 128.9012,
      lat: 47.1901,
      shape: '圆形',
      area: 500,
      elevation: 388,
      slope: 14,
      aspect: '西南',
      forestType: '阔叶林',
      canopyDensity: 0.65,
      dominantSpecies: '蒙古栎',
      surveyRound: 1,
      surveyedAt: now - 3 * day,
      crew: '调查二组（周砚）',
      locked: false,
      createdAt: now - 120 * day,
    },
  ];

  type Seed = [string, string, number, number, number, number, TreeRecord['status']];
  const seeds: Seed[] = [
    ['1', '红松', 34.2, 18.6, 7.4, 5.2, '活立木'],
    ['2', '紫椴', 26.8, 15.2, 5.1, 4.4, '活立木'],
    ['3', '红松', 41.5, 21.3, 9.2, 6.1, '活立木'],
    ['4', '蒙古栎', 18.4, 11.5, 3.6, 3.2, '活立木'],
    ['5', '色木槭', 12.6, 9.4, 2.8, 2.6, '活立木'],
  ];

  const trees: TreeRecord[] = [];
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw, status]) => {
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: dbh,
      heightM: h,
      underBranchH: ubh,
      crownWidth: cw,
      status,
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 1,
      measuredAt: now - 370 * day,
    });
  });
  // 第 2 期：树号 1/2/3/5 复测（胸径增大），树号 4 被采伐 → 复查比对可标记缺失
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw], index) => {
    if (treeNo === '4') return;
    const growth = [1.8, 1.4, 2.2, 0.9][index > 3 ? 3 : index];
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: Math.round((dbh + growth) * 10) / 10,
      heightM: Math.round((h + growth * 0.6) * 10) / 10,
      underBranchH: ubh,
      crownWidth: cw,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 2,
      measuredAt: now - 6 * day,
    });
  });
  // 第 2 期新增进界木
  trees.push({
    id: newId('tree'),
    plotId,
    treeNo: '6',
    species: '色木槭',
    dbhCm: 6.2,
    heightM: 6.1,
    underBranchH: 1.8,
    crownWidth: 1.9,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 1,
    remark: '样地东南 3m 进界木',
    round: 2,
    measuredAt: now - 6 * day,
  });
  trees.push({
    id: newId('tree'),
    plotId: plot2Id,
    treeNo: '1',
    species: '蒙古栎',
    dbhCm: 22.4,
    heightM: 13.2,
    underBranchH: 4.2,
    crownWidth: 4.1,
    status: '活立木',
    origin: '天然',
    healthClass: '亚健康',
    tiltDeg: 6,
    remark: '样地西侧',
    round: 1,
    measuredAt: now - 3 * day,
  });

  const regens: RegenShrub[] = [
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '红松',
      heightCm: 32,
      count: 18,
      ageGroup: '3 年生',
      distribution: '团状',
      browseDamage: '轻度',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '紫椴',
      heightCm: 55,
      count: 9,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '灌木',
      species: '毛榛子',
      heightCm: 120,
      count: 26,
      ageGroup: '多年生',
      distribution: '团状',
      browseDamage: '中度',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '草本',
      species: '苔草',
      heightCm: 22,
      count: 140,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    },
  ];

  // 第 1 → 第 2 期逐株复查比对（随第 2 期发布时冻结）
  const rechecks: RecheckDiff[] = buildRecheckDiffs(
    plotId,
    1,
    2,
    trees.filter((t) => t.plotId === plotId && t.round === 1),
    trees.filter((t) => t.plotId === plotId && t.round === 2),
    now - 6 * day,
  );

  const archives: RoundArchive[] = [
    {
      id: newId('arch'),
      plotId,
      round: 1,
      status: 'published',
      locked: true,
      createdAt: now - 380 * day,
      publishedAt: now - 370 * day,
      plotSnapshot: plotSnapshotOf(plots[0]),
      trees: trees.filter((t) => t.plotId === plotId && t.round === 1).map((t) => ({ ...t })),
      regens: [],
      rechecks: [],
    },
    {
      id: newId('arch'),
      plotId,
      round: 2,
      status: 'published',
      locked: true,
      createdAt: now - 30 * day,
      publishedAt: now - 6 * day,
      plotSnapshot: plotSnapshotOf(plots[0]),
      trees: trees.filter((t) => t.plotId === plotId && t.round === 2).map((t) => ({ ...t })),
      regens: regens.filter((r) => r.plotId === plotId).map((r) => ({ ...r })),
      rechecks: rechecks.map((d) => ({ ...d })),
    },
    {
      id: newId('arch'),
      plotId: plot2Id,
      round: 1,
      status: 'draft',
      locked: false,
      createdAt: now - 3 * day,
      trees: trees.filter((t) => t.plotId === plot2Id).map((t) => ({ ...t })),
      regens: [],
      rechecks: [],
    },
  ];

  await db.transaction(
    'rw',
    db.plots,
    db.trees,
    db.regens,
    db.rechecks,
    db.archives,
    async () => {
      await db.plots.bulkPut(plots);
      await db.trees.bulkPut(trees);
      await db.regens.bulkPut(regens);
      await db.rechecks.bulkPut(rechecks);
      await db.archives.bulkPut(archives);
    },
  );
}
