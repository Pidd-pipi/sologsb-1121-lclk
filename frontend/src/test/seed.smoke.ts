/* eslint-disable */
// v3 新库冒烟：确保示范数据在所有 UI 选择器下自洽
import 'fake-indexeddb/auto';

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
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as any).BroadcastChannel = FakeBC;
(globalThis as any).window = globalThis;

let passed = 0;
let failed = 0;
const check = (n: string, c: boolean, d = '') => (c ? (passed++, console.log(`  ✓ ${n}`)) : (failed++, console.error(`  ✗ ${n} ${d}`)));

async function main() {
  const { ensureSeedData, db, loadRecheckDiffs } = await import('../utils/db');
  const { useRoundStore } = await import('../stores/roundStore');
  const { usePlotStore } = await import('../stores/plotStore');
  const { useTreeStore } = await import('../stores/treeStore');
  const { useRegenStore } = await import('../stores/regenStore');

  await ensureSeedData();
  await Promise.all([
    usePlotStore.getState().load(),
    useTreeStore.getState().load(),
    useRegenStore.getState().load(),
    useRoundStore.getState().load(),
  ]);

  for (const plot of usePlotStore.getState().items) {
    console.log(`# ${plot.plotNo}`);
    const archives = useRoundStore.getState().byPlot(plot.id);
    check('至少有一份档案', archives.length >= 1);
    const draft = archives.find((a) => a.status === 'draft');
    const latestPublished = archives.filter((a) => a.status !== 'draft').slice(-1)[0];
    check('最多一份草稿', archives.filter((a) => a.status === 'draft').length <= 1);

    // 所有活动行都必须挂在存在的档案上
    const roundIds = new Set(archives.map((a) => a.id));
    const trees = useTreeStore.getState().items.filter((t) => t.plotId === plot.id);
    const regens = useRegenStore.getState().items.filter((r) => r.plotId === plot.id);
    check('样木 roundId 全部有效', trees.every((t) => roundIds.has(t.roundId)));
    check('更新层 roundId 全部有效', regens.every((r) => roundIds.has(r.roundId)));
    check('草稿之外没有活动样木挂在已发布档案', archives.every((a) => a.status === 'draft' || trees.every((t) => t.roundId !== a.id)));

    // 已发布档案的快照自洽
    for (const a of archives.filter((x) => x.snapshot)) {
      check(`第 ${a.roundNo} 期快照行 round 号一致`, a.snapshot!.trees.every((t) => t.round === a.roundNo));
      check(`第 ${a.roundNo} 期快照树号无重复`, new Set(a.snapshot!.trees.map((t) => t.treeNo)).size === a.snapshot!.trees.length);
    }

    // syncFromArchives 不抛错且期号回写正确
    await usePlotStore.getState().syncFromArchives(plot.id);
    const after = usePlotStore.getState().items.find((p) => p.id === plot.id)!;
    const expectedRound = (draft ?? latestPublished)?.roundNo;
    check('plot.surveyRound 已同步到当前档案', after.surveyRound === expectedRound, `${after.surveyRound} vs ${expectedRound}`);

    // 锁定草稿不可写
    if (draft) {
      if (draft.locked) {
        let blocked = false;
        try {
          await useTreeStore.getState().add({
            plotId: plot.id, treeNo: 'zz', species: 'x', dbhCm: 1, heightM: 1, underBranchH: 1,
            crownWidth: 1, status: '活立木', origin: '天然', healthClass: '健康', tiltDeg: 0,
            remark: '', round: draft.roundNo, roundId: draft.id,
          });
        } catch { blocked = true; }
        check('锁定草稿写入被拒', blocked);
      }
      // 已发布期活动行应为 0（活动数据只属于草稿）
      check('已发布档案下无活动行', archives.filter((a) => a.status !== 'draft').every((a) =>
        useTreeStore.getState().items.filter((t) => t.roundId === a.id).length === 0));
    }
  }

  // roundStore 选择器
  const p1 = usePlotStore.getState().items.find((p) => p.plotNo === 'FP-4102')!;
  const arcs = useRoundStore.getState().byPlot(p1.id);
  const { currentArchiveOf, latestPublishedOf, draftOf, sortArchives } = await import('../types/roundArchive');
  const cur = currentArchiveOf(arcs);
  check('当前档案在有草稿时是草稿', cur?.status === 'draft', cur?.status ?? 'undefined');
  check('最近已发布不受草稿影响', latestPublishedOf(arcs)?.roundNo === 1);
  check('排序按期号', sortArchives(arcs).map((a) => a.roundNo).join(',') === '1,2');
  void draftOf;
  void db;
  void loadRecheckDiffs;

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
