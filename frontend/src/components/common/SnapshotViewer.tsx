import { Modal, Tabs, Tag, Typography } from 'antd';
import type { RoundArchive } from '../../types/roundArchive';
import { roundArchiveLabel } from '../../types/roundArchive';
import TreeTable from './TreeTable';
import GrowthDiffTable from './GrowthDiffTable';
import { snapshotTrees, snapshotRegens } from '../../hooks/useArchiveData';
import type { RegenShrub } from '../../types/regen';
import { Table, type TableProps } from 'antd';

type RegenColumns = NonNullable<TableProps<RegenShrub>['columns']>;

export interface SnapshotViewerProps {
  archive: RoundArchive | null;
  onClose: () => void;
}

/** 只读查看某份已发布档案定格的样木、更新层与复查结果 */
export default function SnapshotViewer({ archive, onClose }: SnapshotViewerProps) {
  if (!archive) return null;
  const snap = archive.snapshot;
  const trees = snapshotTrees(archive);
  const regens = snapshotRegens(archive);
  const diffs = (snap?.diffs ?? []).map((d, i) => ({
    ...d,
    id: `snap-diff:${archive.id}:${i}`,
    plotId: archive.plotId,
    roundId: archive.id,
  }));

  const regenColumns: RegenColumns = [
    { title: '层位', dataIndex: 'layer', width: 90, render: (v: string) => <Tag>{v}</Tag> },
    { title: '种类', dataIndex: 'species', width: 130 },
    { title: '高度 cm', dataIndex: 'heightCm', width: 100 },
    { title: '株数', dataIndex: 'count', width: 80 },
    { title: '苗龄组', dataIndex: 'ageGroup', width: 100 },
    { title: '分布', dataIndex: 'distribution', width: 80 },
    { title: '啃食情况', dataIndex: 'browseDamage', width: 100 },
  ];

  return (
    <Modal
      open
      width={1100}
      footer={null}
      onCancel={onClose}
      title={
        <span>
          档案快照 · {roundArchiveLabel(archive)}
          {archive.locked ? <Tag color="orange" style={{ marginLeft: 8 }}>发布时已锁定</Tag> : null}
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            定格于 {snap ? new Date(snap.savedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
          </Typography.Text>
        </span>
      }
    >
      <Tabs
        items={[
          {
            key: 'trees',
            label: `样木（${trees.length}）`,
            children: <TreeTable items={trees} showClassSummary={false} emptyText="该期快照无样木" />,
          },
          {
            key: 'regens',
            label: `更新层（${regens.length}）`,
            children: (
              <Table<RegenShrub>
                rowKey="id"
                size="small"
                columns={regenColumns}
                dataSource={regens}
                pagination={false}
                locale={{ emptyText: '该期快照无更新层记录' }}
              />
            ),
          },
          {
            key: 'diffs',
            label: `复查结果（${diffs.length}）`,
            children: <GrowthDiffTable diffs={diffs} emptyText="发布时未保存复查比对结果" />,
          },
        ]}
      />
    </Modal>
  );
}
