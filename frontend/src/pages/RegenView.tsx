import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import { CopyOutlined, PlusOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useRegenStore } from '../stores/regenStore';
import { useArchiveStore } from '../stores/archiveStore';
import RoundTag from '../components/common/RoundTag';
import {
  AGE_GROUPS,
  BROWSE_DAMAGES,
  DISTRIBUTIONS,
  REGEN_LAYERS,
  type BrowseDamage,
  type Distribution,
  type RegenLayer,
  type RegenShrub,
  type RegenShrubDraft,
} from '../types/regen';
import { heightClassStats } from '../utils/forestCalc';
import { perHectareCount } from '../utils/forestCalc';
import { regensOfRound } from '../utils/roundData';

type Columns = NonNullable<TableProps<RegenShrub>['columns']>;

/** /plots/:id/regen 更新苗与灌木样方记录，按高度级与株数分组合计 */
export default function RegenView() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const regens = useRegenStore((s) => s.items);
  const addRegen = useRegenStore((s) => s.add);
  const removeRegen = useRegenStore((s) => s.remove);
  const archivesAll = useArchiveStore((s) => s.items);
  const busy = useArchiveStore((s) => s.busy);
  const startRevision = useArchiveStore((s) => s.startRevision);

  const archives = useMemo(
    () => archivesAll.filter((a) => a.plotId === id).sort((a, b) => a.round - b.round),
    [archivesAll, id],
  );
  const rounds = archives.map((a) => a.round);

  const [round, setRound] = useState(plot?.surveyRound ?? 1);
  useEffect(() => {
    if (plot) setRound(plot.surveyRound);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot?.id]);

  const archive = archives.find((a) => a.round === round);
  const readonly = archive?.status === 'published';

  const rows = useMemo(
    () =>
      regensOfRound(archivesAll, regens, id, round).sort(
        (a, b) => a.layer.localeCompare(b.layer) || b.heightCm - a.heightCm,
      ),
    [archivesAll, regens, id, round],
  );

  const [layerFilter, setLayerFilter] = useState<RegenLayer | 'all'>('all');
  const [form, setForm] = useState<RegenShrubDraft>({
    plotId: id,
    layer: '更新苗',
    species: '',
    heightCm: 40,
    count: 10,
    ageGroup: '2 年生',
    distribution: '均匀',
    browseDamage: '无',
    round,
  });
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    setForm((prev) => ({ ...prev, plotId: id, round }));
  }, [id, round]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = rows.filter((r) => layerFilter === 'all' || r.layer === layerFilter);
  const heightStats = heightClassStats(filtered);
  const totalCount = filtered.reduce((s, r) => s + r.count, 0);

  const columns: Columns = [
    {
      title: '层位',
      dataIndex: 'layer',
      width: 100,
      render: (v: string) => <Tag color={v === '更新苗' ? 'green' : v === '灌木' ? 'blue' : 'default'}>{v}</Tag>,
    },
    { title: '种类', dataIndex: 'species', width: 140 },
    {
      title: '高度 cm',
      dataIndex: 'heightCm',
      width: 110,
      sorter: (a: RegenShrub, b: RegenShrub) => a.heightCm - b.heightCm,
    },
    { title: '株数', dataIndex: 'count', width: 90 },
    { title: '苗龄组', dataIndex: 'ageGroup', width: 110 },
    { title: '分布', dataIndex: 'distribution', width: 90 },
    {
      title: '啃食情况',
      dataIndex: 'browseDamage',
      width: 110,
      render: (v: string) => <Tag color={v === '无' ? 'green' : v === '重度' ? 'red' : 'orange'}>{v}</Tag>,
    },
    {
      title: '期次',
      dataIndex: 'round',
      width: 90,
      render: (v: number) => `第 ${v} 期`,
    },
    {
      title: '操作',
      width: 90,
      render: (_: unknown, row: RegenShrub) =>
        readonly ? (
          <Tag>只读</Tag>
        ) : (
          <Button
            size="small"
            danger
            onClick={async () => {
              try {
                await removeRegen(row.id);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            删除
          </Button>
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

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          更新苗与灌木层 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={round} locked={archive?.locked ?? plot.locked} archive={archive} />
        <Tag>样地面积 {plot.area} m²</Tag>
        {archive?.sourceRound ? <Tag color="purple">修订自第 {archive.sourceRound} 期</Tag> : null}
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/recheck`}>复查比对</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/archives`}>期次档案</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
      </Space>

      <Card size="small">
        <Space wrap size={12}>
          <span>
            查看/登记期次
            <Select
              style={{ width: 150, marginLeft: 6 }}
              value={round}
              onChange={setRound}
              options={(rounds.length ? rounds : [plot.surveyRound]).map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          {readonly ? (
            <Space>
              <Tag color="green">已发布冻结，数据只读</Tag>
              <Button
                size="small"
                icon={<CopyOutlined />}
                loading={!!busy[`rev:${id}:${round}`]}
                onClick={async () => {
                  try {
                    const created = await startRevision(id, round);
                    setRound(created.round);
                    setToast(`已生成第 ${created.round} 期修订草稿，原第 ${round} 期快照不变`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                从本期生成修订期
              </Button>
            </Space>
          ) : null}
        </Space>
      </Card>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {readonly ? (
        <Alert
          type="info"
          showIcon
          message={`第 ${round} 期已发布归档，展示发布时冻结的更新层快照；如需更正请生成修订期。`}
        />
      ) : null}

      <Card size="small" title="登记样方记录" style={{ opacity: readonly ? 0.6 : 1 }}>
        <Space wrap size={8} style={{ pointerEvents: readonly ? 'none' : 'auto' }}>
          <Select
            style={{ width: 110 }}
            value={form.layer}
            onChange={(v) => setForm({ ...form, layer: v as RegenLayer })}
            options={REGEN_LAYERS.map((l) => ({ value: l, label: l }))}
          />
          <Input
            style={{ width: 150 }}
            placeholder="种类"
            value={form.species}
            onChange={(e) => setForm({ ...form, species: e.target.value })}
          />
          <span>
            高度 cm
            <InputNumber
              style={{ width: 100, marginLeft: 4 }}
              min={1}
              max={800}
              value={form.heightCm}
              onChange={(v) => setForm({ ...form, heightCm: Number(v ?? 0) })}
            />
          </span>
          <span>
            株数
            <InputNumber
              style={{ width: 90, marginLeft: 4 }}
              min={1}
              max={5000}
              value={form.count}
              onChange={(v) => setForm({ ...form, count: Number(v ?? 0) })}
            />
          </span>
          <Select
            style={{ width: 110 }}
            value={form.ageGroup}
            onChange={(v) => setForm({ ...form, ageGroup: v })}
            options={AGE_GROUPS.map((a) => ({ value: a, label: a }))}
          />
          <Select
            style={{ width: 100 }}
            value={form.distribution}
            onChange={(v) => setForm({ ...form, distribution: v as Distribution })}
            options={DISTRIBUTIONS.map((d) => ({ value: d, label: d }))}
          />
          <Select
            style={{ width: 110 }}
            value={form.browseDamage}
            onChange={(v) => setForm({ ...form, browseDamage: v as BrowseDamage })}
            options={BROWSE_DAMAGES.map((d) => ({ value: d, label: d }))}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={async () => {
              if (!form.species.trim()) {
                setError('种类必填');
                return;
              }
              try {
                await addRegen({ ...form, species: form.species.trim(), round });
                setError('');
                setToast(`已登记 ${form.layer} · ${form.species.trim()}（${form.count} 株）`);
                setForm({ ...form, species: '' });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            保存记录
          </Button>
        </Space>
      </Card>

      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="样方记录" value={filtered.length} suffix="条" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="合计株数" value={totalCount} suffix="株" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="更新苗密度"
              value={perHectareCount(
                filtered.filter((r) => r.layer === '更新苗').reduce((s, r) => s + r.count, 0),
                plot.area,
              )}
              suffix="株/hm²"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="灌木密度"
              value={perHectareCount(
                filtered.filter((r) => r.layer === '灌木').reduce((s, r) => s + r.count, 0),
                plot.area,
              )}
              suffix="株/hm²"
            />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="按高度级统计株数">
        <Space wrap size={6}>
          {heightStats.map((h) => (
            <Tag key={h.label} color={h.count > 0 ? 'cyan' : 'default'}>
              {h.label} · {h.count} 株
            </Tag>
          ))}
        </Space>
      </Card>

      <Card
        size="small"
        title="样方记录清单"
        extra={
          <Space>
            <Select
              style={{ width: 130 }}
              value={layerFilter}
              onChange={(v) => setLayerFilter(v as RegenLayer | 'all')}
              options={[{ value: 'all', label: '全部层位' }, ...REGEN_LAYERS.map((l) => ({ value: l, label: l }))]}
            />
          </Space>
        }
      >
        <Table<RegenShrub>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={filtered}
          pagination={false}
          locale={{ emptyText: '暂无样方记录' }}
        />
      </Card>
    </Space>
  );
}
