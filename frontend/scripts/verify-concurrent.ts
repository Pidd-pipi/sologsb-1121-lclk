/* eslint-disable */
// 跨实例并发：模拟两个终端同时「新开下一期」，验证事务级不会各建一期
import 'fake-indexeddb/auto';
import assert from 'node:assert';
import { db, ensureSeedData } from '../src/utils/db';
import { useArchiveStore } from '../src/stores/archiveStore';

await db.open();
await ensureSeedData();
await useArchiveStore.getState().load();

const plot = (await db.table('plots').where('plotNo').equals('FP-4102').first())!;
const plotId = plot.id;

// 绕过单飞锁，直接用两套独立 store 状态并发发起事务（模拟两台终端）
const store = useArchiveStore.getState();
// @ts-ignore 直接拿到动作内部逻辑：构造两个无共享内存缓存的调用
async function rawCreate() {
  const { newId } = await import('../src/utils/id');
  const latest = (await db.table('archives').where('plotId').equals(plotId).filter((a: any) => a.status === 'published').toArray())
    .sort((a: any, b: any) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
  const existing = await db.table('archives').where('plotId').equals(plotId).toArray();
  const newRound = Math.max(...existing.map((a: any) => a.round)) + 1;
  const now = Date.now();
  const carried = latest.trees
    .filter((t: any) => t.status !== '采伐')
    .map((t: any) => ({ ...t, id: newId('tree'), round: newRound, measuredAt: now }));
  const draft = {
    id: newId('arch'), plotId, round: newRound, status: 'draft', locked: false,
    createdAt: now, trees: carried, regens: [], rechecks: [],
  };
  return db.transaction('rw', db.archives, db.trees, db.plots, async () => {
    // 与 archiveStore 相同的事务内复查
    const fresh = await db.archives.where('plotId').equals(plotId).toArray();
    if (fresh.some((a: any) => a.status === 'draft' || a.round === newRound)) {
      return { reused: true };
    }
    await db.trees.bulkPut(carried);
    await db.archives.put(draft);
    await db.plots.update(plotId, { surveyRound: newRound });
    return { reused: false };
  });
}

const results = await Promise.all([rawCreate(), rawCreate()]);
const created = results.filter((r) => r.reused === false).length;
assert.equal(created, 1, `只应有一个事务真正建期，实际 ${created}`);
const drafts = await db.table('archives').where('plotId').equals(plotId).filter((a: any) => a.status === 'draft').toArray();
assert.equal(drafts.length, 1, '库里只有一条草稿');
const round3Trees = await db.table('trees').where('plotId').equals(plotId).filter((t: any) => t.round === 3).count();
assert.equal(round3Trees, 5, '第 3 期底稿树只插入一次（5 株，无重复）');
console.log('✓ 两终端并发新开：一个建期、一个复用，无重复期次与重复工作行');
db.close();
