import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import {
  CopyOutlined,
  EyeOutlined,
  PlusOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useArchiveStore } from '../stores/archiveStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import RoundTag from '../components/common/RoundTag';
import TreeTable from '../components/common/TreeTable';
import GrowthDiffTable from '../components/common/GrowthDiffTable';
import type { RegenShrub } from '../types/regen';
import type { RoundArchive } from '../types/archive';
import { regensOfRound, rechecksOfRound, treesOfRound } from '../utils/roundData';
import { loadRecheckDiffs } from '../utils/db';
import type { RecheckDiff } from '../types/recheck';

type Columns = NonNullable<TableProps<RegenShrub>['columns']>;

/** /plots/:id/archives 期次档案：可发布、可追溯，修订期标明来源 */
export default function RoundArchives() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const archivesAll = useArchiveStore((s) => s.items);
  const workingTrees = useTreeStore((s) => s.items);
  const workingRegens = useRegenStore((s) => s.items);
  const busy = useArchiveStore((s) => s.busy);
  const startNextRound = useArchiveStore((s) => s.startNextRound);
  const startRevision = useArchiveStore((s) => s.startRevision);
  const publishDraft = useArchiveStore((s) => s.publishDraft);
  const discardDraft = useArchiveStore((s) => s.discardDraft);

  const archives = useMemo(
    () => archivesAll.filter((a) => a.plotId === id).sort((a, b) => b.round - a.round),
    [archivesAll, id],
  );
  const draft = archives.find((a) => a.status === 'draft');
  const [viewing, setViewing] = useState<number | null>(null);
  const [revisionSource, setRevisionSource] = useState<number | null>(null);
  const [revisionNote, setRevisionNote] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [workingRechecks, setWorkingRechecks] = useState<RecheckDiff[]>([]);

  useEffect(() => {
    let alive = true;
    void loadRecheckDiffs(id).then((rows) => {
      if (alive) setWorkingRechecks(rows);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const flash = (msg: string) => {
    setError('');
    setToast(msg);
    window.setTimeout(() => setToast(''), 3000);
  };
  const fail = (msg: string) => {
    setToast('');
    setError(msg);
  };

  const viewArchive =
    viewing !== null ? archives.find((a) => a.round === viewing) ?? null : null;

  const regenColumns: Columns = [
    { title: '层位', dataIndex: 'layer', width: 100 },
    { title: '种类', dataIndex: 'species', width: 140 },
    { title: '高度 cm', dataIndex: 'heightCm', width: 100 },
    { title: '株数', dataIndex: 'count', width: 90 },
    { title: '苗龄组', dataIndex: 'ageGroup', width: 110 },
    { title: '分布', dataIndex: 'distribution', width: 90 },
    { title: '啃食情况', dataIndex: 'browseDamage', width: 110 },
  ];

  const archiveColumns: NonNullable<TableProps<RoundArchive>['columns']> = [
    {
      title: '期次',
      dataIndex: 'round',
      width: 110,
      render: (round: number, row: RoundArchive) => <RoundTag round={round} locked={row.locked} archive={row} />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (status: RoundArchive['status']) =>
        status === 'published' ? <Tag color="green">已发布</Tag> : <Tag color="gold">草稿</Tag>,
    },
    {
      title: '来源',
      width: 150,
      render: (_: unknown, row: RoundArchive) =>
        row.sourceRound ? <Tag color="purple">修订自第 {row.sourceRound} 期</Tag> : '原始期',
    },
    {
      title: '内容',
      render: (_: unknown, row: RoundArchive) => (
        <Space size={4} wrap>
          <Tag>样木 {row.status === 'published' ? row.trees.length : treesOfRound(archivesAll, workingTrees, id, row.round).length} 株</Tag>
          <Tag>更新层 {row.status === 'published' ? row.regens.length : regensOfRound(archivesAll, workingRegens, id, row.round).length} 条</Tag>
          <Tag>复查 {row.status === 'published' ? row.rechecks.length : rechecksOfRound(archivesAll, workingRechecks, id, row.round).length} 条</Tag>
        </Space>
      ),
    },
    {
      title: '发布时间',
      dataIndex: 'publishedAt',
      width: 180,
      render: (value?: number) => (value ? new Date(value).toLocaleString('zh-CN') : '—'),
    },
    {
      title: '备注',
      dataIndex: 'note',
      width: 180,
      ellipsis: true,
      render: (v?: string) => v ?? '—',
    },
    {
      title: '操作',
      width: 240,
      render: (_: unknown, row: RoundArchive) => (
        <Space size={4} wrap>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setViewing(row.round)}>
            查看
          </Button>
          {row.status === 'draft' ? (
            <>
              <Button
                size="small"
                type="primary"
                icon={<SendOutlined />}
                loading={!!busy[`pub:${id}:${row.round}`]}
                onClick={async () => {
                  try {
                    await publishDraft(id, row.round);
                    flash(`第 ${row.round} 期已发布归档，样木、更新层与复查结果已冻结`);
                  } catch (e) {
                    fail((e as Error).message);
                  }
                }}
              >
                发布
              </Button>
              <Button
                size="small"
                danger
                loading={!!busy[`discard:${id}:${row.round}`]}
                onClick={() => {
                  Modal.confirm({
                    title: `丢弃第 ${row.round} 期草稿？`,
                    content: '草稿中的样木与样方工作行会一并删除，已发布期次不受影响。',
                    okText: '丢弃',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: async () => {
                      await discardDraft(id, row.round);
                      if (viewing === row.round) setViewing(null);
                      flash(`第 ${row.round} 期草稿已丢弃`);
                    },
                  });
                }}
              >
                丢弃
              </Button>
            </>
          ) : (
            <Button
              size="small"
              icon={<CopyOutlined />}
              loading={!!busy[`rev:${id}:${row.round}`]}
              onClick={() => {
                setRevisionSource(row.round);
                setRevisionNote('');
              }}
            >
              生成修订期
            </Button>
          )}
        </Space>
      ),
    },
  ];

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

  const viewTrees = viewArchive
    ? treesOfRound(archivesAll, workingTrees, id, viewArchive.round)
    : [];
  const viewRegens = viewArchive
    ? regensOfRound(archivesAll, workingRegens, id, viewArchive.round)
    : [];
  const viewRechecks = viewArchive
    ? rechecksOfRound(archivesAll, workingRechecks, id, viewArchive.round)
    : [];

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          期次档案 · {plot.plotNo}
        </Typography.Title>
        <Tag>{plot.forestType}</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/regen`}>更新与灌木</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/recheck`}>复查比对</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Card size="small">
        <Space wrap>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={!!busy[`next:${id}`]}
            disabled={!!draft}
            onClick={async () => {
              try {
                const r = await startNextRound(id);
                flash(
                  r.reused
                    ? `已有第 ${r.archive.round} 期草稿，请继续录入后发布（不会重复建期）`
                    : `已基于最近一次已发布快照开出第 ${r.archive.round} 期草稿`,
                );
                setViewing(r.archive.round);
              } catch (e) {
                fail((e as Error).message);
              }
            }}
          >
            新开下一期
          </Button>
          <Typography.Text type="secondary">
            下一期只以最近一次已发布快照为底稿；未发布草稿不会混入，连点不会多期。
          </Typography.Text>
        </Space>
      </Card>

      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="档案期数" value={archives.length} suffix="期" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已发布" value={archives.filter((a) => a.status === 'published').length} suffix="期" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="修订期"
              value={archives.filter((a) => a.sourceRound !== undefined).length}
              suffix="期"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="未发布草稿" value={draft ? 1 : 0} suffix="期" />
          </Card>
        </Col>
      </Row>

      <Table<RoundArchive>
        rowKey="id"
        size="small"
        columns={archiveColumns}
        dataSource={archives}
        pagination={false}
        locale={{ emptyText: '暂无期次档案' }}
      />

      <Modal
        open={revisionSource !== null}
        title={revisionSource !== null ? `从第 ${revisionSource} 期生成修订期` : ''}
        okText="生成修订期"
        cancelText="取消"
        onCancel={() => setRevisionSource(null)}
        onOk={async () => {
          if (revisionSource === null) return;
          try {
            const created = await startRevision(id, revisionSource, revisionNote.trim() || undefined);
            setRevisionSource(null);
            flash(
              `已生成第 ${created.round} 期修订草稿（底稿来自第 ${revisionSource} 期），原档案保持不变`,
            );
            setViewing(created.round);
          } catch (e) {
            fail((e as Error).message);
          }
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
            修订期会复制原期的样木与更新层作为新草稿（新期号），复查结果需重新生成；
            原期快照仍可查阅，并会标明来源期。
          </Typography.Paragraph>
          <Typography.Text>修订原因（可选）</Typography.Text>
          <Input
            value={revisionNote}
            placeholder="如：胸径 3 号桩读数笔误"
            onChange={(e) => setRevisionNote(e.target.value)}
          />
        </Space>
      </Modal>

      <Modal
        open={viewArchive !== null}
        title={
          viewArchive ? (
            <Space>
              <span>
                第 {viewArchive.round} 期档案
                {viewArchive.sourceRound ? `（修订自第 ${viewArchive.sourceRound} 期）` : ''}
              </span>
              {viewArchive.status === 'published' ? (
                <Tag color="green">已发布 · 只读</Tag>
              ) : (
                <Tag color="gold">草稿 · 可编辑</Tag>
              )}
            </Space>
          ) : (
            ''
          )
        }
        width={1080}
        footer={
          viewArchive?.status === 'draft' ? (
            <Space>
              <Button
                danger
                onClick={() => {
                  Modal.confirm({
                    title: `丢弃第 ${viewArchive.round} 期草稿？`,
                    content: '草稿中的样木与样方工作行会一并删除，已发布期次不受影响。',
                    okText: '丢弃',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: async () => {
                      await discardDraft(id, viewArchive.round);
                      setViewing(null);
                      flash(`第 ${viewArchive.round} 期草稿已丢弃`);
                    },
                  });
                }}
              >
                丢弃草稿
              </Button>
              <Button
                type="primary"
                icon={<SendOutlined />}
                loading={!!busy[`pub:${id}:${viewArchive.round}`]}
                onClick={async () => {
                  try {
                    await publishDraft(id, viewArchive.round);
                    flash(`第 ${viewArchive.round} 期已发布归档`);
                  } catch (e) {
                    fail((e as Error).message);
                  }
                }}
              >
                发布该期
              </Button>
            </Space>
          ) : (
            <Button onClick={() => setViewing(null)}>关闭</Button>
          )
        }
        onCancel={() => setViewing(null)}
      >
        {viewArchive ? (
          <Tabs
            items={[
              {
                key: 'trees',
                label: `样木（${viewTrees.length} 株）`,
                children: (
                  <TreeTable
                    items={viewTrees}
                    peers={viewTrees}
                    showClassSummary={false}
                    emptyText="该期没有样木记录"
                  />
                ),
              },
              {
                key: 'regens',
                label: `更新层（${viewRegens.length} 条）`,
                children: (
                  <Table<RegenShrub>
                    rowKey="id"
                    size="small"
                    columns={regenColumns}
                    dataSource={viewRegens}
                    pagination={false}
                    locale={{ emptyText: '该期没有更新层记录' }}
                  />
                ),
              },
              {
                key: 'rechecks',
                label: `复查结果（${viewRechecks.length} 条）`,
                children:
                  viewRechecks.length > 0 ? (
                    <GrowthDiffTable diffs={viewRechecks} />
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      message={
                        viewArchive.status === 'draft'
                          ? '草稿期暂无保存的比对结果：请在复查比对页生成并保存，发布时一并冻结。'
                          : '该期没有冻结的复查比对结果。'
                      }
                    />
                  ),
              },
              {
                key: 'meta',
                label: '样地信息',
                children: viewArchive.plotSnapshot ? (
                  <Descriptions size="small" column={2} bordered>
                    <Descriptions.Item label="样地号">{viewArchive.plotSnapshot.plotNo}</Descriptions.Item>
                    <Descriptions.Item label="地点">{viewArchive.plotSnapshot.locality}</Descriptions.Item>
                    <Descriptions.Item label="林型">{viewArchive.plotSnapshot.forestType}</Descriptions.Item>
                    <Descriptions.Item label="优势树种">{viewArchive.plotSnapshot.dominantSpecies}</Descriptions.Item>
                    <Descriptions.Item label="面积">{viewArchive.plotSnapshot.area} m²</Descriptions.Item>
                    <Descriptions.Item label="郁闭度">{viewArchive.plotSnapshot.canopyDensity}</Descriptions.Item>
                    <Descriptions.Item label="调查组">{viewArchive.plotSnapshot.crew}</Descriptions.Item>
                    <Descriptions.Item label="调查时间">
                      {new Date(viewArchive.plotSnapshot.surveyedAt).toLocaleDateString('zh-CN')}
                    </Descriptions.Item>
                    <Descriptions.Item label="原锁定状态">
                      {viewArchive.locked ? '已锁定' : '未锁定'}
                    </Descriptions.Item>
                    <Descriptions.Item label="发布时间">
                      {viewArchive.publishedAt ? new Date(viewArchive.publishedAt).toLocaleString('zh-CN') : '—'}
                    </Descriptions.Item>
                  </Descriptions>
                ) : (
                  <Alert type="info" showIcon message="草稿期尚未冻结样地元信息，发布后写入。" />
                ),
              },
            ]}
          />
        ) : null}
      </Modal>
    </Space>
  );
}
