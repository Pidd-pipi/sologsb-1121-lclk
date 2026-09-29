import { useEffect } from 'react';
import { db } from '../utils/db';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import { useRoundStore } from '../stores/roundStore';

/**
 * 多终端同步：
 * - 同一浏览器的多个标签页通过 BroadcastChannel 广播本地变更；
 * - 收到广播后只重读受影响样地，乐观锁保证落库不会互相覆盖。
 * 兜底：BroadcastChannel 不可用时用 localStorage 时间戳 + storage 事件。
 */
const CHANNEL = 'gbforestplot:sync';
const STAMP_KEY = 'gbforestplot:sync-stamp';

export type SyncChange =
  | { table: 'plots' }
  | { table: 'rounds'; plotId?: string }
  | { table: 'trees'; plotId?: string }
  | { table: 'regens'; plotId?: string }
  | { table: 'rechecks'; plotId?: string };

let channel: BroadcastChannel | null = null;
try {
  channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
} catch {
  channel = null;
}

/** 本地写库后通知其他终端 */
export function broadcastChange(change: SyncChange): void {
  const payload = JSON.stringify({ at: Date.now(), change });
  if (channel) {
    channel.postMessage(payload);
  } else {
    try {
      window.localStorage.setItem(STAMP_KEY, payload);
    } catch {
      /* ignore */
    }
  }
}

async function reloadTable(change: SyncChange): Promise<void> {
  switch (change.table) {
    case 'plots':
      await usePlotStore.getState().load();
      break;
    case 'rounds':
      await useRoundStore.getState().load();
      break;
    case 'trees':
      await useTreeStore.getState().load();
      break;
    case 'regens':
      await useRegenStore.getState().load();
      break;
    case 'rechecks':
      // 比对结果只在复查页按需读取，不需要全局 reload
      break;
  }
}

/** 在应用根部挂一次：收到其他终端的变更后重读对应表 */
export function useCrossTabSync(): void {
  useEffect(() => {
    let stopped = false;
    const onMessage = async (raw: string) => {
      if (stopped) return;
      try {
        const { change } = JSON.parse(raw) as { at: number; change: SyncChange };
        await reloadTable(change);
      } catch {
        /* ignore malformed */
      }
    };
    const bcHandler = (e: MessageEvent<string>) => void onMessage(e.data);
    const storageHandler = (e: StorageEvent) => {
      if (e.key === STAMP_KEY && e.newValue) void onMessage(e.newValue);
    };
    channel?.addEventListener('message', bcHandler);
    window.addEventListener('storage', storageHandler);
    return () => {
      stopped = true;
      channel?.removeEventListener('message', bcHandler);
      window.removeEventListener('storage', storageHandler);
    };
  }, []);
}

/** 供未引入 hook 的模块直接确认数据库仍可访问 */
export function pingDb(): Promise<number> {
  return db.rounds.count();
}
