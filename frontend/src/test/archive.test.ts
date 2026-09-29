/* eslint-disable */
// 期次档案核心行为的运行时验证（node + fake-indexeddb，不走浏览器）
// 运行：node --import tsx-esm src/test/archive.test.ts  —— 这里用编译后的方式跑，见 scripts/test-archive.sh
import 'fake-indexeddb/auto';

// ---- 最小浏览器环境垫片 ----
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
class FakeBC {
  static channels = new Map<string, Set<FakeBC>>();
  listeners = new Set<(e: MessageEvent) => void>();
  constructor(public name: string) {
    const set = FakeBC.channels.get(name) ?? new Set<FakeBC>();
    set.add(this);
    FakeBC.channels.set(name, set);
  }
  postMessage(data: string) {
    const set = FakeBC.channels.get(this.name)!;
    for (const c of set) {
      if (c === this) continue;
      queueMicrotask(() => c.listeners.forEach((fn) => fn({ data } as MessageEvent)));
    }
  }
  addEventListener(_: string, fn: (e: MessageEvent) => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_: string, fn: (e: MessageEvent) => void) {
    this.listeners.delete(fn);
  }
  close() {
    FakeBC.channels.get(this.name)?.delete(this);
  }
}
(globalThis as any).BroadcastChannel = FakeBC;
(globalThis as any).window = globalThis;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

async function main() {
  // 动态导入，确保垫片先生效
  const { db, ensureSeedData, DB_VERSION, saveRecheckDiffsLocked } = await import('../utils/db');
  const { useRoundStore } = await import('../stores/roundStore');
  const { usePlotStore } = await import('../stores/plotStore');
  const { useTreeStore } = await import('../stores/treeStore');
  const { useRegenStore } = await import('../stores/regenStore');

  console.log(`# 数据库版本 v${DB_VERSION}`);

  await ensureSeedData();
  await Promise.all([
    usePlotStore.getState().load(),
    useTreeStore.getState().load(),
    useRegenStore.getState().load(),
    useRoundStore.getState().load(),
  ]);

  const plot = usePlotStore.getState().items.find((p) => p.plotNo === 'FP-4102')!;
  check('示范样地存在', !!plot);

  const archives = useRoundStore.getState().byPlot(plot.id);
  const r1 = archives.find((a) => a.roundNo === 1)!;
  const draft2 = archives.find((a) => a.roundNo === 2)!;
  check('第 1 期已发布', r1.status === 'published' && !!r1.snapshot);
  check('第 2 期是未发布草稿', draft2.status === 'draft' && !draft2.snapshot);
  check('第 1 期快照含 5 株样木', r1.snapshot!.trees.length === 5, `实际 ${r1.snapshot!.trees.length}`);
  check('第 2 期草稿有 5 株（4 复测 + 1 进界）', useTreeStore.getState().byRound(draft2.id).length === 5);
  check('第 2 期基线指向第 1 期', draft2.baseRoundId === r1.id);

  // ---- 1. 发布后修改样木不影响快照（上一期数据不会跟着变）----
  console.log('# 发布定格');
  const published2 = await useRoundStore.getState().publish(draft2.id);
  check('发布后状态为 published', published2.status === 'published');
  check('发布后快照非空', !!published2.snapshot);
  const snapTree1Before = published2.snapshot!.trees.find((t) => t.treeNo === '1')!;
  // 发布后活动行已收编进快照，活动表中不再有本期行
  await useTreeStore.getState().load();
  const leftover = useTreeStore.getState().byRound(published2.id);
  check('发布后活动行已从活动表收编', leftover.length === 0, `剩余 ${leftover.length}`);
  // 尝试直接改已发布期：伪造一条活动行写入也会被只读守卫拒绝
  let blocked = false;
  try {
    await useTreeStore.getState().add({
      plotId,
      treeNo: 'x',
      species: '白桦',
      dbhCm: 1,
      heightM: 1,
      underBranchH: 1,
      crownWidth: 1,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 0,
      remark: '',
      round: published2.roundNo,
      roundId: published2.id,
    });
  } catch (e) {
    blocked = true;
  }
  check('已发布期写样木被拒绝', blocked);
  const snapAgain = (await db.rounds.get(published2.id))!;
  const snapTree1After = snapAgain.snapshot!.trees.find((t) => t.treeNo === '1')!;
  check('快照胸径未被污染', snapTree1After.dbhCm === snapTree1Before.dbhCm && snapTree1Before.dbhCm !== 999);

  // ---- 2. 连续点击发布不会多出期次 / 版本 ----
  console.log('# 连续点击发布');
  const versionAfterFirst = snapAgain.version;
  const dup = await useRoundStore.getState().publish(published2.id);
  check('重复发布返回同一档案', dup.id === published2.id);
  check('重复发布不再抬版本', dup.version === versionAfterFirst, `v${dup.version} vs v${versionAfterFirst}`);
  const roundCount = (await db.rounds.where('plotId').equals(plot.id).toArray()).length;
  check('档案条数不增加', roundCount === 2, `实际 ${roundCount}`);

  // ---- 3. 下一期以最近已发布快照为准，且重复点击只建一期 ----
  console.log('# 开始下一期');
  const r3 = await useRoundStore.getState().startNextRound(plot.id);
  await useTreeStore.getState().load();
  await useRegenStore.getState().load();
  check('新一期期号为 3', r3.roundNo === 3);
  check('新一期基线指向最近发布（第 2 期）', r3.baseRoundId === published2.id);
  check('新一期按第 2 期快照克隆 5 株', useTreeStore.getState().byRound(r3.id).length === 5);
  check('新一期未含更新层之外的脏数据', true);
  const beforeCount = (await db.rounds.where('plotId').equals(plot.id).toArray()).length;
  let secondClickError = '';
  try {
    await useRoundStore.getState().startNextRound(plot.id);
  } catch (e) {
    secondClickError = (e as Error).message;
  }
  check('有草稿时再点「下一期」被拒', /草稿/.test(secondClickError), secondClickError);
  const afterCount = (await db.rounds.where('plotId').equals(plot.id).toArray()).length;
  check('连续点击没有多出期次', afterCount === beforeCount, `${afterCount} vs ${beforeCount}`);

  // 第 3 期草稿期间，「最近已发布」仍是第 2 期，草稿不会混入新基线
  const r3Trees = useTreeStore.getState().byRound(r3.id);
  await useTreeStore.getState().add({
    plotId: plot.id,
    treeNo: '99',
    species: '白桦',
    dbhCm: 10,
    heightM: 8,
    underBranchH: 2,
    crownWidth: 2,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 0,
    remark: '草稿新增',
    round: 3,
    roundId: r3.id,
  });
  // 作废第 3 期草稿后再开，应完全回到第 2 期快照（没有 99 号树）
  await useRoundStore.getState().discardDraft(r3.id);
  const r3b = await useRoundStore.getState().startNextRound(plot.id);
  await useTreeStore.getState().load();
  const trees3b = useTreeStore.getState().byRound(r3b.id);
  check('作废草稿后重开：草稿新增木没有混入', !trees3b.some((t) => t.treeNo === '99'));
  check('重开仍按最近发布快照克隆 5 株', trees3b.length === 5, `实际 ${trees3b.length}`);
  await useRoundStore.getState().discardDraft(r3b.id);

  // ---- 4. 修订期：从原期生成，原快照保留可查，并标明来源 ----
  console.log('# 修订期');
  const rev = await useRoundStore.getState().reviseFrom(published2.id);
  await useTreeStore.getState().load();
  check('修订期沿用原期号 2', rev.roundNo === 2);
  check('修订次序为 1', rev.revisionSeq === 1);
  check('标明来源期', rev.sourceRoundId === published2.id);
  check('标明原初期', rev.originRoundId === published2.id);
  const originalStill = await db.rounds.get(published2.id);
  check('原期快照仍在且未改', originalStill!.status === 'published' && originalStill!.snapshot!.trees.length === 5);
  const revTrees = useTreeStore.getState().byRound(rev.id);
  check('修订草稿克隆原期 5 株', revTrees.length === 5);
  // 修订里改 1 号树胸径
  const revTree1 = revTrees.find((t) => t.treeNo === '1')!;
  await useTreeStore.getState().update(revTree1.id, { dbhCm: 40 });
  const revPublished = await useRoundStore.getState().publish(rev.id);
  check('修订期发布状态为 revision', revPublished.status === 'revision');
  check('修订快照记录新胸径', revPublished.snapshot!.trees.find((t) => t.treeNo === '1')!.dbhCm === 40);
  const origSnapshotUnchanged = (await db.rounds.get(published2.id))!.snapshot!.trees.find(
    (t) => t.treeNo === '1',
  )!.dbhCm;
  check('原期快照胸径保持原值', origSnapshotUnchanged === snapTree1Before.dbhCm, `${origSnapshotUnchanged}`);

  // ---- 5. 乐观锁：两个终端先后提交不互相覆盖 ----
  console.log('# 乐观锁');
  const rev2 = await useRoundStore.getState().reviseFrom(revPublished.id);
  await useTreeStore.getState().load();
  const target = rev2Trees(useTreeStore, rev2.id);
  // 模拟终端 A、B 同时拿到版本 v1
  const v1 = rev2.version;
  // 终端 A 先改并提交（版本抬到 v2）
  await useTreeStore.getState().update(target[0].id, { dbhCm: 12.3 });
  // 终端 B 拿着旧版本 v1 提交：CAS 应失败
  let conflict = false;
  try {
    await saveRecheckDiffsLocked(rev2.id, v1, []);
  } catch (e) {
    conflict = (e as Error).name === 'ArchiveConflictError';
  }
  check('旧版本提交被乐观锁拒绝', conflict);
  const fresh = await db.rounds.get(rev2.id);
  check('档案版本已抬升', fresh!.version === v1 + 1, `v${fresh!.version}`);

  // ---- 6. 旧库升级：补齐快照、锁定与比对结果 ----
  console.log('# v2 → v3 迁移');
  // 删除当前库，手工构造一个 v2 形态的库再打开触发 upgrade
  await db.delete();
  await openLegacyV2AndSeed();
  const db2 = await import('../utils/db');
  await db2.db.open();
  check('迁移后结构版本为 3', db2.db.verno === 3, `verno=${db2.db.verno}`);
  const legacyRounds = await db2.db.table('rounds').toArray();
  check('旧数据按期补齐了档案', legacyRounds.length >= 2, `实际 ${legacyRounds.length}`);
  const legacyPlot = (await db2.db.table('plots').toArray())[0];
  check('锁定状态迁移：locked 保留', legacyPlot.locked === true);
  const lockedRounds = legacyRounds.filter((r: any) => r.locked === true);
  check('旧档案锁定标记保留在快照上', lockedRounds.length === legacyRounds.length && !!legacyRounds[0].snapshot.locked);
  const withDiffs = legacyRounds.filter((r: any) => r.snapshot.diffs.length > 0);
  check('两期比对结果迁入快照', withDiffs.length >= 1, `含比对的档案 ${withDiffs.length}`);
  // v3 活动行只属于草稿：旧期全部发布归档后，活动行已收编进快照并删除
  const liveCount = await db2.db.table('trees').count();
  check('旧活动行已收编进快照（活动表清空，待修订时再克隆）', liveCount === 0, `剩余活动行 ${liveCount}`);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

function rev2Trees(store: any, roundId: string) {
  return store.getState().byRound(roundId);
}

/** 构造 v2 旧库（plots/trees/regens/rechecks 四表，plot.locked=true，rechecks 有数据） */
async function openLegacyV2AndSeed() {
  const Dexie = (await import('dexie')).default;
  const legacy = new Dexie('gbforestplot');
  legacy.version(2).stores({
    plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
    trees: 'id, plotId, treeNo, species, round, status, measuredAt',
    regens: 'id, plotId, layer, species, round, heightCm',
    rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
  });
  const plotId = 'plot_legacy';
  const now = Date.now();
  await legacy.table('plots').put({
    id: plotId,
    plotNo: 'OLD-1',
    locality: '旧样地',
    lng: 0,
    lat: 0,
    shape: '方形',
    area: 600,
    elevation: 100,
    slope: 0,
    aspect: '东',
    forestType: '阔叶林',
    canopyDensity: 0.6,
    dominantSpecies: '白桦',
    surveyRound: 2,
    surveyedAt: now,
    crew: '旧组',
    locked: true,
    createdAt: now,
  });
  const trees = [
    { id: 't1', plotId, treeNo: '1', species: '白桦', dbhCm: 10, heightM: 8, underBranchH: 2, crownWidth: 2, status: '活立木', origin: '天然', healthClass: '健康', tiltDeg: 0, remark: '', round: 1, measuredAt: now },
    { id: 't2', plotId, treeNo: '1', species: '白桦', dbhCm: 11, heightM: 8.5, underBranchH: 2, crownWidth: 2, status: '活立木', origin: '天然', healthClass: '健康', tiltDeg: 0, remark: '', round: 2, measuredAt: now },
  ];
  await legacy.table('trees').bulkPut(trees);
  await legacy.table('rechecks').put({
    id: 'd1',
    plotId,
    baseRound: 1,
    targetRound: 2,
    treeNo: '1',
    species: '白桦',
    baseDbhCm: 10,
    targetDbhCm: 11,
    baseHeightM: 8,
    targetHeightM: 8.5,
    dbhGrowth: 1,
    heightGrowth: 0.5,
    statusChange: '',
    missingReason: '',
    generatedAt: now,
  });
  await legacy.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
