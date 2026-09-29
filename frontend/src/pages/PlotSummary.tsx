import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useRegenStore } from '../stores/regenStore';
import { useTreeStore } from '../stores/treeStore';
import { useArchiveStore } from '../stores/archiveStore';
import { useTreeStats } from '../hooks/useTreeStats';
import RoundTag from '../components/common/RoundTag';
import PlotCard from '../components/common/PlotCard';
import { canopyFromCrown, formHeight, heightClassStats } from '../utils/forestCalc';
import { regensOfRound } from '../utils/roundData';
import type { PlotSnapshot } from '../types/archive';
import type { TreeRecord } from '../types/tree';

interface SpeciesRow {
  key: string;
  species: string;
  count: number;
  meanDbh: number;
  meanHeight: number;
}

/** /summary/:plotId 林分因子汇总，可导出调查记录文本；已发布期读冻结快照 */
export default function PlotSummary() {
  const { plotId = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === plotId));
  const trees = useTreeStore((s) => s.items);
  const regens = useRegenStore((s) => s.items);
  const archivesAll = useArchiveStore((s) => s.items);

  const archives = useMemo(
    () => archivesAll.filter((a) => a.plotId === plotId).sort((a, b) => a.round - b.round),
    [archivesAll, plotId],
  );
  const rounds = archives.map((a) => a.round);

  const [round, setRound] = useState(plot?.surveyRound ?? 1);
  useEffect(() => {
    if (plot) setRound(plot.surveyRound);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot?.id]);

  const archive = archives.find((a) => a.round === round);
  const stats = useTreeStats(plotId, round);

  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 已发布期：面积/元信息与更新层均取冻结快照
  const meta: PlotSnapshot | undefined = archive?.status === 'published' ? archive.plotSnapshot : plot;
  const plotRegens = useMemo(
    () => regensOfRound(archivesAll, regens, plotId, round),
    [archivesAll, regens, plotId, round],
  );

  const speciesRows = useMemo(() => {
    const map = new Map<string, { species: string; count: number; dbh: number; height: number }>();
    stats.trees
      .filter((t) => t.status === '活立木')
      .forEach((t) => {
        const row = map.get(t.species) ?? { species: t.species, count: 0, dbh: 0, height: 0 };
        row.count += 1;
        row.dbh += t.dbhCm;
        row.height += t.heightM;
        map.set(t.species, row);
      });
    return Array.from(map.values()).map((r) => ({
      key: r.species,
      species: r.species,
      count: r.count,
      meanDbh: Math.round((r.dbh / r.count) * 100) / 100,
      meanHeight: Math.round((r.height / r.count) * 100) / 100,
    }));
  }, [stats.trees]);

  const speciesColumns: NonNullable<TableProps<SpeciesRow>['columns']> = [
    { title: '树种', dataIndex: 'species' },
    { title: '株数', dataIndex: 'count', width: 100 },
    { title: '平均胸径 cm', dataIndex: 'meanDbh', width: 140 },
    { title: '平均树高 m', dataIndex: 'meanHeight', width: 140 },
    {
      title: '形高',
      width: 120,
      render: (_: unknown, row: SpeciesRow) =>
        formHeight({ dbhCm: row.meanDbh, heightM: row.meanHeight } as TreeRecord),
    },
  ];

  const report = useMemo(() => {
    if (!meta) return '';
    const lines: string[] = [];
    lines.push('森林样地调查记录');
    lines.push(`样地号：${meta.plotNo}`);
    lines.push(`地点：${meta.locality}（${meta.lng}, ${meta.lat}）`);
    lines.push(`形状/面积：${meta.shape} / ${meta.area} m²`);
    lines.push(`海拔：${meta.elevation} m；坡度 ${meta.slope}°；坡向 ${meta.aspect}`);
    lines.push(`林型：${meta.forestType}；优势树种：${meta.dominantSpecies}`);
    lines.push(
      `复查期次：第 ${round} 期${archive?.sourceRound ? `（修订自第 ${archive.sourceRound} 期）` : ''}；调查时间：${new Date(meta.surveyedAt).toLocaleDateString('zh-CN')}`,
    );
    lines.push(`调查组：${meta.crew}`);
    lines.push('');
    lines.push(`每公顷株数：${stats.perHa} 株/hm²`);
    lines.push(`平均胸径：${stats.meanDbh} cm`);
    lines.push(`平均树高：${stats.meanHeight} m`);
    lines.push(`断面积合计：${stats.basalArea} m²（${stats.basalAreaPerHa} m²/hm²）`);
    lines.push(`郁闭度（录入）：${meta.canopyDensity}；按冠幅折算：${canopyFromCrown(stats.trees, meta)}`);
    lines.push(`更新苗密度：${stats.regenPerHa} 株/hm²；灌木密度：${stats.shrubPerHa} 株/hm²`);
    lines.push('');
    lines.push('径阶分布：' + stats.diameterDist.map((d) => `${d.label}cm=${d.count}`).join('，'));
    lines.push('高度级株数：' + heightClassStats(plotRegens).map((h) => `${h.label}=${h.count}`).join('，'));
    lines.push('');
    lines.push('分树种统计：');
    speciesRows.forEach((r) => {
      lines.push(`  ${r.species}：${r.count} 株，平均胸径 ${r.meanDbh} cm，平均树高 ${r.meanHeight} m`);
    });
    lines.push('');
    lines.push(
      `导出时间：${new Date().toLocaleString('zh-CN')}（${archive?.status === 'published' ? '数据来自已发布冻结快照' : '数据来自未发布草稿'}）`,
    );
    return lines.join('\n');
  }, [meta, round, archive, stats, plotRegens, speciesRows]);

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
          林分因子汇总 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={round} locked={archive?.locked ?? plot.locked} archive={archive} />
        {archive?.sourceRound ? <Tag color="purple">修订自第 {archive.sourceRound} 期</Tag> : null}
        <Tag color="green">{plot.forestType}</Tag>
        <Select
          style={{ width: 150, marginLeft: 8 }}
          value={round}
          onChange={setRound}
          options={(rounds.length ? rounds : [plot.surveyRound]).map((r) => ({
            value: r,
            label: `第 ${r} 期`,
          }))}
        />
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
          <Link to={`/plots/${plot.id}/archives`}>期次档案</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {archive?.status === 'published' ? (
        <Alert type="info" showIcon message={`当前展示第 ${round} 期发布时冻结的快照数据，之后的修改不会影响它。`} />
      ) : (
        <Alert type="warning" showIcon message={`第 ${round} 期尚未发布，当前为草稿数据，发布后才会冻结归档。`} />
      )}

      <Row gutter={12}>
        <Col span={8}>
          <PlotCard plot={plot} archive={archive} treeCount={stats.count} />
        </Col>
        <Col span={16}>
          <Row gutter={[12, 12]}>
            <Col span={8}>
              <Card size="small">
                <Statistic title="每公顷株数" value={stats.perHa} suffix="株/hm²" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="平均胸径" value={stats.meanDbh} precision={2} suffix="cm" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="平均树高" value={stats.meanHeight} precision={2} suffix="m" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="断面积合计" value={stats.basalArea} precision={4} suffix="m²" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="每公顷断面积" value={stats.basalAreaPerHa} precision={3} suffix="m²/hm²" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="郁闭度（冠幅折算）" value={canopyFromCrown(stats.trees, meta ?? plot)} precision={3} />
              </Card>
            </Col>
            <Col span={12}>
              <Card size="small">
                <Statistic title="更新苗密度" value={stats.regenPerHa} suffix="株/hm²" />
              </Card>
            </Col>
            <Col span={12}>
              <Card size="small">
                <Statistic title="灌木密度" value={stats.shrubPerHa} suffix="株/hm²" />
              </Card>
            </Col>
          </Row>
        </Col>
      </Row>

      <Card size="small" title="径阶分布与高度级">
        <Space direction="vertical" size={6}>
          <div>
            {stats.diameterDist.map((d) => (
              <Tag key={d.label} color={d.count > 0 ? 'green' : 'default'}>
                {d.label} cm · {d.count} 株
              </Tag>
            ))}
          </div>
          <div>
            {heightClassStats(plotRegens).map((h) => (
              <Tag key={h.label} color={h.count > 0 ? 'cyan' : 'default'}>
                {h.label} · {h.count} 株
              </Tag>
            ))}
          </div>
          <Descriptions size="small" column={3}>
            <Descriptions.Item label="活立木">{stats.aliveCount} 株</Descriptions.Item>
            <Descriptions.Item label="样木记录">{stats.count} 条</Descriptions.Item>
            <Descriptions.Item label="样方记录">{plotRegens.length} 条</Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>

      <Card size="small" title="分树种统计">
        <Table<SpeciesRow>
          rowKey="key"
          size="small"
          columns={speciesColumns}
          dataSource={speciesRows}
          pagination={false}
          locale={{ emptyText: '暂无活立木数据' }}
        />
      </Card>

      <Card
        size="small"
        title="调查记录文本"
        extra={
          <Space>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(report);
                  setToast('调查记录已复制到剪贴板');
                } catch {
                  setToast('浏览器未授权剪贴板，请手动复制下方文本');
                }
              }}
            >
              复制
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<DownloadOutlined />}
              onClick={() => {
                const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `调查记录_${plot.plotNo}_第${round}期.txt`;
                a.click();
                URL.revokeObjectURL(url);
                setToast('调查记录已导出为 txt');
              }}
            >
              导出
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{report}</pre>
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}
