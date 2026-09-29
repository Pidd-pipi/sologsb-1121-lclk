import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import type { RoundArchive, RoundSnapshot } from '../types/roundArchive';
import { ArchiveLockedError } from '../types/roundArchive';
import { newId } from './id';

export const DB_NAME = 'gbforestplot';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbforestplot:db-version';

class ForestPlotDB extends Dexie {
  plots!: Table<Plot, string>;
  trees!: Table<TreeRecord, string>;
  regens!: Table<RegenShrub, string>;
  rechecks!: Table<RecheckDiff, string>;
  rounds!: Table<RoundArchive, string>;

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
    // v3：期次档案表；活动行全部挂到 roundId；旧库按「期」补齐发布快照
    this.version(3)
      .stores({
        plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
        trees: 'id, plotId, treeNo, species, round, roundId, status, measuredAt',
        regens: 'id, plotId, layer, species, round, roundId, heightCm',
        rechecks: 'id, plotId, roundId, baseRound, targetRound, treeNo, generatedAt',
        rounds: 'id, plotId, roundNo, status, sourceRoundId, publishedAt',
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        const plotsTable = tx.table<Plot, string>('plots');
        const treesTable = tx.table<any, string>('trees');
        const regensTable = tx.table<any, string>('regens');
        const rechecksTable = tx.table<any, string>('rechecks');
        const roundsTable = tx.table<RoundArchive, string>('rounds');

        const plots = await plotsTable.toArray();

        for (const plot of plots) {
          const plotTrees = await treesTable.where('plotId').equals(plot.id).toArray();
          const plotRegens = await regensTable.where('plotId').equals(plot.id).toArray();
          const plotRechecks = await rechecksTable.where('plotId').equals(plot.id).toArray();

          const roundNos = Array.from(
            new Set<number>([
              ...plotTrees.map((t) => Number(t.round) || 1),
              ...plotRegens.map((r) => Number(r.round) || 1),
              ...plotRechecks.flatMap((d) =>
                d.targetRound === undefined ? [] : [Number(d.targetRound) || 1],
              ),
              Number(plot.surveyRound) || 1,
            ]),
          ).sort((a, b) => a - b);

          const idByRoundNo = new Map<number, string>();

          roundNos.forEach((roundNo) => {
            const rid = newId('round');
            idByRoundNo.set(roundNo, rid);
          });
          // 先落 id，再组装档案，便于写 baseRoundId
          const sortedIds = roundNos.map((n) => idByRoundNo.get(n) as string);

          for (let index = 0; index < roundNos.length; index += 1) {
            const roundNo = roundNos[index];
            const rid = sortedIds[index];
            const baseRoundId = index > 0 ? sortedIds[index - 1] : null;
            const trees = plotTrees
              .filter((t) => (Number(t.round) || 1) === roundNo)
              .map(stripOwnership);
            const regens = plotRegens
              .filter((r) => (Number(r.round) || 1) === roundNo)
              .map(stripOwnership);
            // 两期比对结果原样保留：跟随其 targetRound 进快照，旧档案比对结果不丢
            const diffs = plotRechecks
              .filter((d) => Number(d.targetRound) === roundNo)
              .map(stripOwnership);

            const archive: RoundArchive = {
              id: rid,
              plotId: plot.id,
              roundNo,
              revisionSeq: 0,
              status: 'published',
              version: 1,
              sourceRoundId: null,
              originRoundId: null,
              baseRoundId,
              // 原样保留旧锁定状态：样地锁过期内的所有旧期一并锁定
              locked: !!plot.locked,
              createdAt: now + index,
              publishedAt: now + index,
              snapshot: { trees, regens, diffs, locked: !!plot.locked, savedAt: now },
            };
            await roundsTable.put(archive);
          }

          // v3 起活动行只属于草稿：旧库的每一期都已补成发布快照，活动行统一收编进快照后删除，
          // 之后要改旧期只能从原期「修订」，避免再出现两期间数据互相改动的问题。
          await treesTable.where('plotId').equals(plot.id).delete();
          await regensTable.where('plotId').equals(plot.id).delete();
          await rechecksTable.where('plotId').equals(plot.id).delete();
        }

        // 没有任何分行的空样地：至少补一份与 surveyRound 对齐的档案
        const archiveCount = await roundsTable.count();
        if (archiveCount === 0 && plots.length > 0) {
          for (const plot of plots) {
            const snapshot: RoundSnapshot = {
              trees: [],
              regens: [],
              diffs: [],
              locked: !!plot.locked,
              savedAt: now,
            };
            await roundsTable.put({
              id: newId('round'),
              plotId: plot.id,
              roundNo: Number(plot.surveyRound) || 1,
              revisionSeq: 0,
              status: 'published',
              version: 1,
              sourceRoundId: null,
              originRoundId: null,
              baseRoundId: null,
              locked: !!plot.locked,
              createdAt: now,
              publishedAt: now,
              snapshot,
            });
          }
        }
      });
  }
}

/** 迁移时把活动行裁成快照载荷（去掉主键与归属字段） */
function stripOwnership(row: any): any {
  const { id: _id, plotId: _plotId, roundId: _roundId, ...rest } = row;
  return rest;
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

/** 保存某一期草稿的复查比对（整批覆盖该期，按 treeNo 去重） */
export async function saveRecheckDiffs(roundId: string, diffs: RecheckDiff[]): Promise<void> {
  await db.transaction('rw', db.rechecks, async () => {
    await db.rechecks.where('roundId').equals(roundId).delete();
    if (diffs.length > 0) await db.rechecks.bulkPut(diffs);
  });
}

/**
 * 带乐观锁保存复查比对：档案仍是草稿且版本 == expected 时才覆盖写入并把版本 +1。
 * 两个终端先后保存时后到一方会收到 ArchiveConflictError，比对结果不会互相覆盖。
 */
export async function saveRecheckDiffsLocked(
  roundId: string,
  expectedVersion: number,
  diffs: RecheckDiff[],
): Promise<number> {
  let changed = 0;
  await db.transaction('rw', db.rechecks, db.rounds, async () => {
    const archive = await db.rounds.get(roundId);
    if (!archive) throw new Error('期次档案不存在');
    if (archive.status !== 'draft') {
      throw new ArchiveLockedError('本期刚被其他终端发布归档，请刷新查看');
    }
    if (archive.version !== expectedVersion) {
      const err = new Error('该期已被其他终端提交，请刷新后以最新版本重试');
      err.name = 'ArchiveConflictError';
      throw err;
    }
    await db.rechecks.where('roundId').equals(roundId).delete();
    if (diffs.length > 0) await db.rechecks.bulkPut(diffs);
    await db.rounds
      .where('id')
      .equals(roundId)
      .and((a) => a.version === expectedVersion)
      .modify((a) => {
        a.version = expectedVersion + 1;
        changed += 1;
      });
    if (changed === 0) {
      const err = new Error('该期已被其他终端提交，请刷新后以最新版本重试');
      err.name = 'ArchiveConflictError';
      throw err;
    }
  });
  return expectedVersion + 1;
}

export async function loadRecheckDiffs(plotId: string, roundId?: string): Promise<RecheckDiff[]> {
  const rows =
    roundId === undefined
      ? await db.rechecks.where('plotId').equals(plotId).toArray()
      : await db.rechecks.where('roundId').equals(roundId).toArray();
  return rows.sort((a, b) => a.treeNo.localeCompare(b.treeNo));
}

/** 首次进入灌入示范样地与两期样木数据（第 1 期已发布归档，第 2 期为在录草稿） */
export async function ensureSeedData(): Promise<void> {
  const count = await db.plots.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const plotId = newId('plot');
  const plot2Id = newId('plot');
  const round1Id = newId('round');
  const round2Id = newId('round');
  const p2round1Id = newId('round');

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
      locked: false,
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
      locked: true,
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
      roundId: round1Id,
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
      roundId: round2Id,
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
    roundId: round2Id,
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
    roundId: p2round1Id,
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
      roundId: round2Id,
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
      roundId: round2Id,
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
      roundId: round2Id,
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
      roundId: round2Id,
    },
  ];

  const round1Archive: RoundArchive = {
    id: round1Id,
    plotId,
    roundNo: 1,
    revisionSeq: 0,
    status: 'published',
    version: 1,
    sourceRoundId: null,
    originRoundId: null,
    baseRoundId: null,
    locked: true,
    createdAt: now - 370 * day,
    publishedAt: now - 360 * day,
    snapshot: null,
  };
  round1Archive.snapshot = {
    trees: trees
      .filter((t) => t.roundId === round1Id)
      .map(({ id: _id, plotId: _p, roundId: _r, ...rest }) => rest),
    regens: [],
    diffs: [],
    locked: true,
    savedAt: round1Archive.publishedAt as number,
  };

  const round2Archive: RoundArchive = {
    id: round2Id,
    plotId,
    roundNo: 2,
    revisionSeq: 0,
    status: 'draft',
    version: 1,
    sourceRoundId: null,
    originRoundId: null,
    baseRoundId: round1Id,
    locked: false,
    createdAt: now - 6 * day,
    publishedAt: null,
    snapshot: null,
  };

  const p2Archive: RoundArchive = {
    id: p2round1Id,
    plotId: plot2Id,
    roundNo: 1,
    revisionSeq: 0,
    status: 'published',
    version: 1,
    sourceRoundId: null,
    originRoundId: null,
    baseRoundId: null,
    locked: true,
    createdAt: now - 3 * day,
    publishedAt: now - 3 * day,
    snapshot: null,
  };
  p2Archive.snapshot = {
    trees: trees
      .filter((t) => t.roundId === p2round1Id)
      .map(({ id: _id, plotId: _p, roundId: _r, ...rest }) => rest),
    regens: [],
    diffs: [],
    locked: true,
    savedAt: p2Archive.publishedAt as number,
  };

  await db.transaction('rw', db.plots, db.trees, db.regens, db.rechecks, db.rounds, async () => {
    await db.plots.bulkPut(plots);
    await db.rounds.bulkPut([round1Archive, round2Archive, p2Archive]);
    // 活动行只属于草稿期；第 1 期（含样地 2）已发布，数据只进快照
    await db.trees.bulkPut(trees.filter((t) => t.roundId === round2Id));
    await db.regens.bulkPut(regens.filter((r) => r.roundId === round2Id));
  });
}
