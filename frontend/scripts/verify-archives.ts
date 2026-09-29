/* eslint-disable */
// 期次档案核心逻辑端到端验证（fake-indexeddb + Dexie，不经 UI）
import 'fake-indexeddb/auto';
import assert from 'node:assert';
import { db, ensureSeedData, DB_VERSION } from '../src/utils/db';
import { useArchiveStore } from '../src/stores/archiveStore';
import { useTreeStore } from '../src/stores/treeStore';
import { usePlotStore } from '../src/stores/plotStore';
import { treesOfRound, latestPublished } from '../src/utils/roundData';
import { replaceRecheckDiffs, loadRecheckDiffs } from '../src/utils/db';
import { buildRecheckDiffs } from '../src/utils/recheck';

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed += 1;
  console.log('  ✓', name);
}

async function setup() {
  await db.open();
  await ensureSeedData();
  await useArchiveStore.getState().load();
  await usePlotStore.getState().load();
  await useTreeStore.getState().load();
}

async function main() {
  assert.equal(DB_VERSION, 3, 'DB 版本为 v3');
  await setup();

  const plots = usePlotStore.getState().items;
  const plot = plots.find((p) => p.plotNo === 'FP-4102')!;
  const archives = useArchiveStore.getState().byPlot(plot.id);
  console.log(`\n样地 ${plot.plotNo} 初始档案：`, archives.map((a) => `${a.round}:${a.status}`));

  // 1. 种子数据：第 1、2 期已发布，第 2 期带冻结复查
  check('种子：存在第 1 期已发布档案', archives.some((a) => a.round === 1 && a.status === 'published'));
  const r2 = archives.find((a) => a.round === 2)!;
  check('种子：第 2 期已发布', r2.status === 'published');
  check('种子：第 2 期冻结 5 株样木（1/2/3/5/6）', r2.trees.length === 5);
  check('种子：第 2 期冻结 4 条更新层', r2.regens.length === 4);
  check('种子：第 2 期冻结 6 条两期比对', r2.rechecks.length === 6);
  check('种子：原 locked=true 保留到发布快照', r2.locked === true);
  check('种子：样地元信息已冻结', r2.plotSnapshot?.plotNo === 'FP-4102');

  // 2. 发布后改工作表，不影响旧快照
  const liveRound2Trees = useTreeStore
    .getState()
    .items.filter((t) => t.plotId === plot.id && t.round === 2);
  // 直接在库中篡改工作表（模拟「改样木导致上一期数据跟着变」的老问题）
  liveRound2Trees.forEach((t) => (t.dbhCm = 999));
  await db.trees.bulkPut(liveRound2Trees);
  const snapshotR2 = useArchiveStore.getState().items.find((a) => a.id === r2.id)!;
  check('发布后工作表被改，快照样木不变', snapshotR2.trees.every((t) => t.dbhCm !== 999));

  // 页面经选择器读取第 2 期时也拿快照
  const effective = treesOfRound(
    useArchiveStore.getState().items,
    useTreeStore.getState().items,
    plot.id,
    2,
  );
  check('选择器读取已发布期返回冻结数据（无 999）', effective.every((t) => t.dbhCm !== 999));

  // store 层写保护
  let blocked = false;
  try {
    await useTreeStore.getState().update(liveRound2Trees[0].id, { dbhCm: 5 });
  } catch {
    blocked = true;
  }
  check('已发布期禁止 update（写保护生效）', blocked);

  // 3. 连点「新开下一期」→ 只有一个新期草稿
  const before = useArchiveStore.getState().byPlot(plot.id).length;
  const [c1, c2, c3] = await Promise.all([
    useArchiveStore.getState().startNextRound(plot.id),
    useArchiveStore.getState().startNextRound(plot.id),
    useArchiveStore.getState().startNextRound(plot.id),
  ]);
  check('连点新开：三次调用同一份草稿 id', c1.archive.id === c2.archive.id && c2.archive.id === c3.archive.id);
  check('连点新开：三次拿到同一结果（单飞）', c1.reused === c2.reused && c2.reused === c3.reused);
  const after = useArchiveStore.getState().byPlot(plot.id);
  check('连点新开：档案总数只 +1', after.length === before + 1);
  // 创建完成后再次调用 → 走「已有草稿复用」分支
  const again = await useArchiveStore.getState().startNextRound(plot.id);
  check('已有草稿时再点：复用，不新增', again.reused === true && again.archive.id === c1.archive.id);
  check('复用后档案总数不变', useArchiveStore.getState().byPlot(plot.id).length === after.length);
  const draft3 = after.find((a) => a.round === 3)!;
  check('新开：第 3 期是草稿', draft3.status === 'draft' && draft3.round === 3);

  // 4. 底稿来自最近已发布快照（第 2 期），且未含采伐木 4 号
  const carried = draft3.trees.map((t) => t.treeNo).sort();
  check('新开：底稿为第 2 期保留木 1/2/3/5/6（采伐木 4 不延续）', carried.join(',') === '1,2,3,5,6');
  check('新开：底稿样木是新 id 的工作行（不与快照共用 id）', draft3.trees.every((t) => !r2.trees.some((s) => s.id === t.id)));
  check('新开：样地 surveyRound 更新到 3', usePlotStore.getState().items.find((p) => p.id === plot.id)!.surveyRound === 3);
  // 草稿未发布时，latestPublished 仍是第 2 期
  check('未发布草稿不会成为「最近已发布」', latestPublished(after)?.round === 2);

  // 5. 在草稿期录入 + 保存复查 + 发布（连点幂等）
  await useTreeStore.getState().add({
    plotId: plot.id,
    treeNo: '7',
    species: '白桦',
    dbhCm: 8.4,
    heightM: 7,
    underBranchH: 2,
    crownWidth: 2,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 1,
    remark: '第 3 期进界',
    round: 3,
  });
  const diffs = buildRecheckDiffs(
    plot.id,
    2,
    3,
    treesOfRound(useArchiveStore.getState().items, useTreeStore.getState().items, plot.id, 2),
    treesOfRound(useArchiveStore.getState().items, useTreeStore.getState().items, plot.id, 3),
  );
  await replaceRecheckDiffs(plot.id, 3, diffs);
  check('草稿复查已保存（第 3 期工作行 6 条）', (await loadRecheckDiffs(plot.id, 3)).length === 6);

  const [p1, p2] = await Promise.all([
    useArchiveStore.getState().publishDraft(plot.id, 3),
    useArchiveStore.getState().publishDraft(plot.id, 3),
  ]);
  check('连点发布：返回同一份档案 id', p1.id === p2.id);
  check('发布后状态 published', p1.status === 'published' && !!p1.publishedAt);
  check('发布冻结了 6 株样木（含新增 7 号）', p1.trees.length === 6 && p1.trees.some((t) => t.treeNo === '7'));
  check('发布冻结了 6 条复查', p1.rechecks.length === 6);
  check('发布后成为最近已发布', latestPublished(useArchiveStore.getState().byPlot(plot.id))?.round === 3);

  // 6. 再改第 3 期工作行，快照不动
  const live3 = useTreeStore.getState().items.filter((t) => t.plotId === plot.id && t.round === 3);
  await db.trees.bulkPut(live3.map((t) => ({ ...t, dbhCm: 123 })));
  const snap3 = useArchiveStore.getState().items.find((a) => a.round === 3)!;
  check('发布后改第 3 期工作行，快照不跟着变', snap3.trees.every((t) => t.dbhCm !== 123));

  // 7. 从第 1 期生成修订期：新期号、草稿、标明来源、原快照可查
  const rev = await useArchiveStore.getState().startRevision(plot.id, 1, '订正胸径');
  check('修订期拿到新期号 4', rev.round === 4);
  check('修订期是草稿', rev.status === 'draft');
  check('修订期来源标到第 1 期', rev.sourceRound === 1 && rev.sourceArchiveId === archives.find((a) => a.round === 1)!.id);
  check('修订原因保留', rev.note === '订正胸径');
  check('修订底稿来自第 1 期（含当时 5 株，采伐木 4 在列）', rev.trees.length === 5 && rev.trees.some((t) => t.treeNo === '4'));
  const r1Still = useArchiveStore.getState().items.find((a) => a.plotId === plot.id && a.round === 1)!;
  check('原第 1 期快照仍可查且未被修改', r1Still.status === 'published' && r1Still.trees.length === 5);
  check('修订底稿是新工作行 id', rev.trees.every((t) => !r1Still.trees.some((s) => s.id === t.id)));

  // 连点同源修订：复用，不再加期
  const countBeforeRev = useArchiveStore.getState().byPlot(plot.id).length;
  const rev2 = await useArchiveStore.getState().startRevision(plot.id, 1);
  check('连点同源修订复用同一草稿', rev2.id === rev.id);
  check('连点同源修订不多期', useArchiveStore.getState().byPlot(plot.id).length === countBeforeRev);

  // 最近已发布仍是第 3 期（修订期是草稿）
  check('修订草稿不改变最近已发布', latestPublished(useArchiveStore.getState().byPlot(plot.id))?.round === 3);

  // 8. 下一期基于最近已发布（第 3 期）
  await useArchiveStore.getState().discardDraft(plot.id, 4);
  check('丢弃修订草稿后档案移除', !useArchiveStore.getState().byPlot(plot.id).some((a) => a.round === 4));
  const nx = await useArchiveStore.getState().startNextRound(plot.id);
  check('新开第 4 期底稿来自第 3 期快照（6 株）', nx.archive.round === 4 && nx.archive.trees.length === 6);
  check('新底稿来自最近已发布而非更老的第 2 期', nx.archive.trees.some((t) => t.treeNo === '7'));

  // 9. 丢弃草稿并清理工作行 + surveyRound 回落
  await useArchiveStore.getState().discardDraft(plot.id, 4);
  check('丢弃后第 4 期工作树被清理', useTreeStore.getState().items.filter((t) => t.plotId === plot.id && t.round === 4).length === 0);
  check('丢弃后 surveyRound 回落到最后一条档案（3）', usePlotStore.getState().items.find((p) => p.id === plot.id)!.surveyRound === 3);

  console.log(`\n全部 ${passed} 项核心断言通过 ✅`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
