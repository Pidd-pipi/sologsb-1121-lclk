import { useState } from 'react';
import { Alert, Button, Card, Modal, Space, Tag, Timeline, Typography } from 'antd';
import {
  BranchesOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EyeOutlined,
  LockOutlined,
  PlusOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import {
  roundArchiveLabel,
  type RoundArchive,
  ArchiveConflictError,
  ArchiveLockedError,
} from '../../types/roundArchive';
import { useRoundStore } from '../../stores/roundStore';

export interface ArchiveTimelineProps {
  plotId: string;
  archives: RoundArchive[];
  /** 当前在看的档案 id */
  currentId?: string;
  /** 查看某份已发布快照 */
  onView?: (archive: RoundArchive) => void;
  /** 结构变化后通知页面 */
  onChanged?: () => void;
}

function formatTime(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
}

/** 样地期次档案时间线：发布草稿、开下一期、从原期修订、锁定、查看快照 */
export default function ArchiveTimeline({ plotId, archives, currentId, onView, onChanged }: ArchiveTimelineProps) {
  const startNextRound = useRoundStore((s) => s.startNextRound);
  const reviseFrom = useRoundStore((s) => s.reviseFrom);
  const publish = useRoundStore((s) => s.publish);
  const discard = useRoundStore((s) => s.discardDraft);
  const toggleLock = useRoundStore((s) => s.toggleLock);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2800);
  };

  const run = async (task: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await task();
      flash(ok);
      onChanged?.();
    } catch (e) {
      if (e instanceof ArchiveConflictError) setError(e.message);
      else if (e instanceof ArchiveLockedError) setError(e.message);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmDiscard = (archive: RoundArchive) => {
    Modal.confirm({
      title: `作废 ${roundArchiveLabel(archive)}？`,
      content: '该草稿及其样木、更新层、比对结果将一并删除，且不会进入下一期。',
      okText: '作废草稿',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => run(() => discard(archive.id), '草稿已作废'),
    });
  };

  const ordered = [...archives].sort((a, b) => b.roundNo - a.roundNo || b.revisionSeq - a.revisionSeq);
  const draft = archives.find((a) => a.status === 'draft');
  const snapshotCount = (a: RoundArchive) =>
    a.snapshot ? a.snapshot.trees.length + a.snapshot.regens.length + a.snapshot.diffs.length : 0;

  return (
    <Card
      size="small"
      title="期次档案"
      extra={
        <Space>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<PlusOutlined />}
            disabled={busy || !!draft}
            onClick={() => run(() => startNextRound(plotId), '已按最近一次已发布快照开新一期')}
          >
            开始下一期
          </Button>
        </Space>
      }
    >
      {error ? <Alert style={{ marginBottom: 8 }} type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {toast ? <Alert style={{ marginBottom: 8 }} type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {draft ? (
        <Alert
          style={{ marginBottom: 8 }}
          type="warning"
          showIcon
          message={`当前存在未发布草稿：${roundArchiveLabel(draft)}`}
          description="草稿不会作为下一期依据；发布后才会定格为可追溯档案。"
        />
      ) : null}
      <Timeline
        items={ordered.map((a) => {
          const color =
            a.status === 'draft' ? 'orange' : a.status === 'revision' ? 'purple' : 'green';
          const isCurrent = a.id === currentId;
          return {
            color,
            children: (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space wrap size={6}>
                  <Typography.Text strong>{roundArchiveLabel(a)}</Typography.Text>
                  {a.status === 'draft' ? <Tag color="orange">草稿</Tag> : <Tag color="green">已发布</Tag>}
                  {a.status === 'revision' ? <Tag color="purple">修订期</Tag> : null}
                  {a.locked ? <Tag icon={<LockOutlined />}>已锁定</Tag> : null}
                  {isCurrent ? <Tag color="blue">当前查看</Tag> : null}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {a.status === 'draft' ? '建档' : '发布'}：{formatTime(a.status === 'draft' ? a.createdAt : a.publishedAt)}
                  {' · '}快照 {snapshotCount(a)} 行 · 乐观锁版本 v{a.version}
                </Typography.Text>
                {a.sourceRoundId ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <BranchesOutlined /> 来源期：第 {a.roundNo} 期{a.revisionSeq > 1 ? ` · 修订 ${a.revisionSeq - 1}` : ''}原档案（原快照保留可查）
                  </Typography.Text>
                ) : null}
                <Space wrap size={4}>
                  {a.status === 'draft' ? (
                    <>
                      <Button
                        size="small"
                        type="primary"
                        icon={<CloudUploadOutlined />}
                        loading={busy}
                        onClick={() => run(() => publish(a.id), `${roundArchiveLabel(a)} 已发布归档，快照已保存`)}
                      >
                        发布归档
                      </Button>
                      <Button size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDiscard(a)}>
                        作废
                      </Button>
                      <Button
                        size="small"
                        icon={a.locked ? <UnlockOutlined /> : <LockOutlined />}
                        onClick={() => run(() => toggleLock(a.id), a.locked ? '草稿已解锁' : '草稿已锁定')}
                      >
                        {a.locked ? '解锁' : '锁定'}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="small" icon={<EyeOutlined />} onClick={() => onView?.(a)}>
                        查看快照
                      </Button>
                      <Button
                        size="small"
                        icon={<BranchesOutlined />}
                        disabled={busy || !!draft}
                        title={draft ? '请先处理当前未发布草稿' : '从该期生成修订草稿'}
                        onClick={() => run(() => reviseFrom(a.id), `已从 ${roundArchiveLabel(a)} 生成修订草稿`)}
                      >
                        以此期修订
                      </Button>
                      <Button
                        size="small"
                        icon={a.locked ? <UnlockOutlined /> : <LockOutlined />}
                        onClick={() => run(() => toggleLock(a.id), a.locked ? '档案已解锁' : '档案已锁定')}
                      >
                        {a.locked ? '解锁' : '锁定'}
                      </Button>
                    </>
                  )}
                </Space>
              </Space>
            ),
          };
        })}
      />
    </Card>
  );
}
