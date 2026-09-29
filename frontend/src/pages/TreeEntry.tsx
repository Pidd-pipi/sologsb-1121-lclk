import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, ReadOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useTreeStats } from '../hooks/useTreeStats';
import { useArchiveData, snapshotTrees, useReloadAfterRoundChange } from '../hooks/useArchiveData';
import TreeTable from '../components/common/TreeTable';
import RoundTag from '../components/common/RoundTag';
import ArchiveTimeline from '../components/common/ArchiveTimeline';
import SnapshotViewer from '../components/common/SnapshotViewer';
import {
  HEALTH_CLASSES,
  TREE_ORIGINS,
  TREE_STATUSES,
  type TreeOrigin,
  type TreeRecordDraft,
  type TreeStatus,
} from '../types/tree';
import { diameterClassLabel } from '../utils/forestCalc';
import { ArchiveConflictError, ArchiveLockedError, roundArchiveLabel, type RoundArchive } from '../types/roundArchive';

const SPECIES_POOL = ['红松', '紫椴', '蒙古栎', '色木槭', '水曲柳', '胡桃楸', '云杉', '白桦'];

/** /plots/:id/trees 样木录入与清单：按档案期次组织，已发布期只读，草稿可录可改 */
export default function TreeEntry() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const addTree = useTreeStore((s) => s.add);
  const updateTree = useTreeStore((s) => s.update);
  const reloadAfterRoundChange = useReloadAfterRoundChange();
  const { archives, current, draft, trees } = useArchiveData(id);

  // 正在查看的档案 id（默认当前期；可切换到任意已发布快照只读查看）
  const [viewingId, setViewingId] = useState<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<RoundArchive | null>(null);
  useEffect(() => {
    setViewingId(current?.id);
  }, [current?.id]);
  const viewing = archives.find((a) => a.id === viewingId) ?? current;

  const round = viewing?.roundNo ?? plot?.surveyRound ?? 1;
  const viewingReadOnly = viewing ? viewing.status !== 'draft' : true;
  const activeTrees = useMemo(
    () => (viewing ? (viewing.status === 'draft' ? trees : snapshotTrees(viewing)) : []),
    [viewing, trees],
  );

  const stats = useTreeStats(id, round, undefined, { trees: activeTrees });

  const [speciesFilter, setSpeciesFilter] = useState('all');
  const [form, setForm] = useState<TreeRecordDraft>({
    plotId: id,
    treeNo: '',
    species: '',
    dbhCm: 10,
    heightM: 8,
    underBranchH: 2,
    crownWidth: 2,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 0,
    remark: '',
    round: 1,
    roundId: '',
  });
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    setForm((prev) => ({ ...prev, plotId: id, round: draft?.roundNo ?? round, roundId: draft?.id ?? '' }));
  }, [id, draft?.id, draft?.roundNo, round]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const rows = useMemo(
    () => activeTrees.filter((t) => speciesFilter === 'all' || t.species === speciesFilter),
    [activeTrees, speciesFilter],
  );

  const reportError = (e: unknown) => {
    if (e instanceof ArchiveConflictError) {
      setError('该期已被其他终端提交，数据可能已变化。请刷新页面后基于最新版本重试。');
    } else if (e instanceof ArchiveLockedError) {
      setError(e.message);
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async () => {
    if (!draft) {
      setError('当前没有可录入的草稿期；请先「开始下一期」或从已发布期「以此期修订」');
      return;
    }
    if (!form.treeNo.trim()) {
      setError('树号必填');
      return;
    }
    if (!form.species.trim()) {
      setError('树种必填');
      return;
    }
    const draftTrees = trees;
    if (draftTrees.some((t) => t.treeNo === form.treeNo.trim())) {
      setError(`第 ${draft.roundNo} 期已存在树号 ${form.treeNo.trim()}`);
      return;
    }
    try {
      await addTree({
        ...form,
        treeNo: form.treeNo.trim(),
        species: form.species.trim(),
        round: draft.roundNo,
        roundId: draft.id,
      });
      setError('');
      setToast(`已录入${roundArchiveLabel(draft)}样木 ${form.treeNo.trim()}（${diameterClassLabel(form.dbhCm)} cm 径阶）`);
      setForm((prev) => ({ ...prev, treeNo: '', dbhCm: 10, heightM: 8, remark: '' }));
    } catch (e) {
      reportError(e);
    }
  };

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地（可能已被删除）" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

  const editable = !!draft && viewing?.id === draft.id && !draft.locked;

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          样木录入 · {plot.plotNo}
        </Typography.Title>
        {viewing ? (
          <RoundTag
            round={viewing.roundNo}
            locked={viewing.locked}
            revisionSeq={viewing.revisionSeq}
            status={viewing.status}
            sourceRoundNo={viewing.roundNo}
          />
        ) : null}
        <Tag>{plot.forestType}</Tag>
        <Tag color="green">优势树种 {plot.dominantSpecies}</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/regen`}>更新与灌木</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/recheck`}>复查比对</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
        <Button type="link">
          <Link to="/plots">返回台账</Link>
        </Button>
      </Space>

      <Card size="small">
        <Space wrap size={12}>
          <span>
            查看期次
            <Select
              style={{ width: 200, marginLeft: 6 }}
              value={viewing?.id}
              onChange={setViewingId}
              options={archives
                .slice()
                .sort((a, b) => b.roundNo - a.roundNo || b.revisionSeq - a.revisionSeq)
                .map((a) => ({ value: a.id, label: roundArchiveLabel(a) }))}
            />
          </span>
          <span>
            树种筛选
            <Select
              style={{ width: 150, marginLeft: 6 }}
              value={speciesFilter}
              onChange={setSpeciesFilter}
              options={[
                { value: 'all', label: '全部树种' },
                ...Array.from(new Set(activeTrees.map((t) => t.species))).map((s) => ({ value: s, label: s })),
              ]}
            />
          </span>
          <Typography.Text type="secondary">
            已录 {activeTrees.length} 株 · 筛选显示 {rows.length} 株
          </Typography.Text>
          {viewingReadOnly ? (
            <Tag icon={<ReadOutlined />} color="default">
              档案只读：修改请用「以此期修订」生成修订草稿
            </Tag>
          ) : draft?.locked ? (
            <Tag color="orange">草稿已锁定，解锁后可录入</Tag>
          ) : null}
        </Space>
      </Card>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={12}>
        <Col span={14}>
          <Card
            size="small"
            title={draft ? `${roundArchiveLabel(draft)}快速录入` : '当前没有可录入的草稿期'}
          >
            {editable ? (
              <>
                <Space wrap size={8}>
                  <Input
                    style={{ width: 110 }}
                    placeholder="树号"
                    value={form.treeNo}
                    onChange={(e) => setForm({ ...form, treeNo: e.target.value })}
                  />
                  <AutoComplete
                    style={{ width: 150 }}
                    placeholder="树种（可联想）"
                    value={form.species}
                    options={SPECIES_POOL.map((s) => ({ value: s }))}
                    onChange={(v) => setForm({ ...form, species: v })}
                    filterOption={(input, option) => String(option?.value ?? '').includes(input)}
                  />
                  <span>
                    胸径 cm
                    <InputNumber
                      style={{ width: 100, marginLeft: 4 }}
                      min={0}
                      max={200}
                      step={0.1}
                      value={form.dbhCm}
                      onChange={(v) => setForm({ ...form, dbhCm: Number(v ?? 0) })}
                    />
                  </span>
                  <span>
                    树高 m
                    <InputNumber
                      style={{ width: 90, marginLeft: 4 }}
                      min={0}
                      max={60}
                      step={0.1}
                      value={form.heightM}
                      onChange={(v) => setForm({ ...form, heightM: Number(v ?? 0) })}
                    />
                  </span>
                  <span>
                    枝下高 m
                    <InputNumber
                      style={{ width: 90, marginLeft: 4 }}
                      min={0}
                      max={40}
                      step={0.1}
                      value={form.underBranchH}
                      onChange={(v) => setForm({ ...form, underBranchH: Number(v ?? 0) })}
                    />
                  </span>
                  <span>
                    冠幅 m
                    <InputNumber
                      style={{ width: 90, marginLeft: 4 }}
                      min={0}
                      max={30}
                      step={0.1}
                      value={form.crownWidth}
                      onChange={(v) => setForm({ ...form, crownWidth: Number(v ?? 0) })}
                    />
                  </span>
                  <Select
                    style={{ width: 110 }}
                    value={form.status}
                    onChange={(v) => setForm({ ...form, status: v as TreeStatus })}
                    options={TREE_STATUSES.map((s) => ({ value: s, label: s }))}
                  />
                  <Select
                    style={{ width: 90 }}
                    value={form.origin}
                    onChange={(v) => setForm({ ...form, origin: v as TreeOrigin })}
                    options={TREE_ORIGINS.map((s) => ({ value: s, label: s }))}
                  />
                  <Select
                    style={{ width: 110 }}
                    value={form.healthClass}
                    onChange={(v) => setForm({ ...form, healthClass: v })}
                    options={HEALTH_CLASSES.map((s) => ({ value: s, label: s }))}
                  />
                  <span>
                    倾斜 °
                    <InputNumber
                      style={{ width: 90, marginLeft: 4 }}
                      min={0}
                      max={45}
                      value={form.tiltDeg}
                      onChange={(v) => setForm({ ...form, tiltDeg: Number(v ?? 0) })}
                    />
                  </span>
                  <Input
                    style={{ width: 220 }}
                    placeholder="位置描述，如「样地西南 3m」"
                    value={form.remark}
                    onChange={(e) => setForm({ ...form, remark: e.target.value })}
                  />
                  <Button type="primary" icon={<PlusOutlined />} onClick={submit}>
                    录入样木
                  </Button>
                </Space>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  当前待录径阶：{diameterClassLabel(form.dbhCm)} cm（按「6/8/12/16/20/24/28/32+」径阶自动归组）
                </Typography.Paragraph>
              </>
            ) : (
              <Alert
                type="info"
                showIcon
                message="没有可编辑的草稿"
                description={
                  <span>
                    在右侧期次档案中点「开始下一期」（以最近一次已发布快照为底），或对某份已发布档案点「以此期修订」。
                    {draft?.locked ? ' 当前草稿处于锁定状态，点档案卡上的解锁即可继续录入。' : ''}
                  </span>
                }
              />
            )}
          </Card>
        </Col>
        <Col span={10}>
          <ArchiveTimeline
            plotId={id}
            archives={archives}
            currentId={viewing?.id}
            onView={setSnapshot}
            onChanged={() => {
              void reloadAfterRoundChange(id);
            }}
          />
        </Col>
      </Row>

      <Card size="small" title="本期林分速览">
        <Row gutter={8}>
          <Col span={4}>
            <Statistic title="每公顷株数" value={stats.perHa} suffix="株/hm²" />
          </Col>
          <Col span={4}>
            <Statistic title="平均胸径" value={stats.meanDbh} precision={2} suffix="cm" />
          </Col>
          <Col span={4}>
            <Statistic title="断面积" value={stats.basalArea} precision={4} suffix="m²" />
          </Col>
          <Col span={4}>
            <Statistic title="平均树高" value={stats.meanHeight} precision={2} suffix="m" />
          </Col>
          <Col span={4}>
            <Statistic title="每公顷断面积" value={stats.basalAreaPerHa} precision={3} suffix="m²/hm²" />
          </Col>
          <Col span={4}>
            <Statistic title="更新密度" value={stats.regenPerHa} suffix="株/hm²" />
          </Col>
        </Row>
        <div style={{ marginTop: 10 }}>
          {stats.diameterDist.map((d) => (
            <Tag key={d.label} color={d.count > 0 ? 'green' : 'default'}>
              {d.label} cm · {d.count}
            </Tag>
          ))}
        </div>
      </Card>

      <Card size="small" title={`${viewing ? roundArchiveLabel(viewing) : ''}样木清单（${rows.length} 株）`}>
        <TreeTable
          items={rows}
          peers={activeTrees}
          onDbhChange={
            editable
              ? async (treeId, dbhCm) => {
                  try {
                    await updateTree(treeId, { dbhCm });
                    setToast('胸径已更新，径阶与断面积同步重算');
                  } catch (e) {
                    reportError(e);
                  }
                }
              : undefined
          }
        />
      </Card>

      <SnapshotViewer archive={snapshot} onClose={() => setSnapshot(null)} />
    </Space>
  );
}
