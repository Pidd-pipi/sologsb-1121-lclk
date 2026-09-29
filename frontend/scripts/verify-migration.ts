/* eslint-disable */
// v2 → v3 升级迁移验证：老数据补档案快照，locked 与两期比对不丢
import 'fake-indexeddb/auto';
import assert from 'node:assert';
import Dexie from 'dexie';

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed += 1;
  console.log('  ✓', name);
}

async function main() {
  // 1) 先按 v2 结构造一个老库（无 archives 表）
  const old = new Dexie('gbforestplot');
  old.version(2).stores({
    plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
    trees: 'id, plotId, treeNo, species, round, status, measuredAt',
    regens: 'id, plotId, layer, species, round, heightCm',
    rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
  });
  const now = Date.now();
  await old.table('plots').bulkPut([
    {
      id: 'p1', plotNo: 'OLD-1', locality: '老样地', lng: 1, lat: 1, shape: '方形', area: 600,
      elevation: 1, slope: 1, aspect: '东', forestType: '阔叶林', canopyDensity: 0.6,
      dominantSpecies: '栎', surveyRound: 2, surveyedAt: now, crew: '组', locked: true, createdAt: now - 1000,
    },
    {
      id: 'p2', plotNo: 'OLD-2', locality: '空样地', lng: 1, lat: 1, shape: '方形', area: 500,
      elevation: 1, slope: 1, aspect: '东', forestType: '阔叶林', canopyDensity: 0.5,
      dominantSpecies: '桦', surveyRound: 1, surveyedAt: now, crew: '组', locked: false, createdAt: now - 900,
    },
  ]);
  await old.table('trees').bulkPut([
    { id: 't1', plotId: 'p1', treeNo: '1', species: '栎', dbhCm: 10, heightM: 8, underBranchH: 2, crownWidth: 2, status: '活立木', origin: '天然', healthClass: '健康', tiltDeg: 0, remark: '', round: 1, measuredAt: now - 500 },
    { id: 't2', plotId: 'p1', treeNo: '1', species: '栎', dbhCm: 11, heightM: 8.5, underBranchH: 2, crownWidth: 2, status: '活立木', origin: '天然', healthClass: '健康', tiltDeg: 0, remark: '', round: 2, measuredAt: now },
  ]);
  await old.table('regens').bulkPut([
    { id: 'g1', plotId: 'p1', layer: '灌木', species: '榛', heightCm: 80, count: 5, ageGroup: '多年生', distribution: '均匀', browseDamage: '无', round: 2 },
  ]);
  await old.table('rechecks').bulkPut([
    { id: 'd1', plotId: 'p1', baseRound: 1, targetRound: 2, treeNo: '1', species: '栎', baseDbhCm: 10, targetDbhCm: 11, baseHeightM: 8, targetHeightM: 8.5, dbhGrowth: 1, heightGrowth: 0.5, statusChange: '', missingReason: '', generatedAt: now },
  ]);
  old.close();

  // 2) 用 v3 应用代码打开同一库名 → 触发升级
  const { db } = await import('../src/utils/db');
  await db.open();
  assert.equal(db.verno, 3, '库版本升到 3');

  const archives = await db.table('archives').toArray();
  const p1 = archives.filter((a: any) => a.plotId === 'p1').sort((a: any, b: any) => a.round - b.round);
  check('p1 补出 2 期档案', p1.length === 2);
  check('p1 两期都为已发布', p1[0].status === 'published' && p1[1].status === 'published');
  check('p1 第 1 期锁定期保留（locked=true）', p1[0].locked === true);
  check('p1 第 2 期为当前期，不按往期锁定（locked=false）', p1[1].locked === false);
  check('p1 第 1 期快照 1 株', p1[0].trees.length === 1 && p1[0].trees[0].dbhCm === 10);
  check('p1 第 2 期快照 1 株（胸径 11）', p1[1].trees.length === 1 && p1[1].trees[0].dbhCm === 11);
  check('p1 第 2 期快照带更新层 1 条', p1[1].regens.length === 1);
  check('p1 第 2 期快照保留两期比对 1 条', p1[1].rechecks.length === 1 && p1[1].rechecks[0].dbhGrowth === 1);
  check('p1 第 1 期快照无比对', p1[0].rechecks.length === 0);
  check('快照含样地元信息', p1[1].plotSnapshot?.plotNo === 'OLD-1');

  const p2 = archives.filter((a: any) => a.plotId === 'p2');
  check('p2 空数据补 1 条第 1 期草稿', p2.length === 1 && p2[0].round === 1 && p2[0].status === 'draft');

  // 3) 升级后原工作表数据仍在
  check('升级后 trees 仍 2 条', (await db.table('trees').count()) === 2);
  check('升级后 rechecks 仍 1 条', (await db.table('rechecks').count()) === 1);

  // 4) 复合唯一索引兜底：同 plotId+round 二次写入被拒
  const dup = { ...p1[0], id: 'dup-id' };
  let rejected = false;
  try {
    await db.table('archives').put(dup);
  } catch {
    rejected = true;
  }
  check('[plotId+round] 唯一索引拒绝重复期档案', rejected);

  console.log(`\nv2→v3 迁移 ${passed} 项断言通过 ✅`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
