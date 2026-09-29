import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Tag, Typography } from 'antd';
import { SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRoundStore } from '../stores/roundStore';
import { loadRecheckDiffs, saveRecheckDiffsLocked } from '../utils/db';
import { broadcastChange } from '../utils/dbSync';
import GrowthDiffTable from '../components/common/GrowthDiffTable';
import RoundTag from '../components/common/RoundTag';
import ArchiveTimeline from '../components/common/ArchiveTimeline';
import SnapshotViewer from '../components/common/SnapshotViewer';
import { useArchiveData, snapshotTrees, useReloadAfterRoundChange } from '../hooks/useArchiveData';
import { newId } from '../utils/id';
import { growthRate, isDiffAbnormal, type RecheckDiff } from '../types/recheck';
import type { TreeRecord } from '../types/tree';
import {
  ArchiveConflictError,
  ArchiveLockedError,
  roundArchiveLabel,
  sortArchives,
  type RoundArchive,
} from '../types/roundArchive';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** /plots/:id/recheck 复查比对：基线取自已发布快照，比对结果随本期草稿保存、发布时定格 */
export default function RecheckView() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const liveTrees = useTreeStore((s) => s.items);
  const { archives, draft } = useArchiveData(id);
  const reloadAfterRoundChange = useReloadAfterRoundChange();

  // 可作为「本期」的期：草稿优先；否则所有已发布档案
  const targetOptions = useMemo(() => {
    const list = draft ? [draft] : sortArchives(archives);
    return list.filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i);
  }, [draft, archives]);

  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const [baseId, setBaseId] = useState<string | undefined>(undefined);
  const [diffs, setDiffs] = useState<RecheckDiff[]>([]);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [snapshot, setSnapshot] = useState<RoundArchive | null>(null);

  // 默认：本期 = 当前草稿（或最新发布），上期 = 前一份已发布档案
  useEffect(() => {
    const ordered = sortArchives(archives);
    const t = draft ?? ordered[ordered.length - 1];
    setTargetId((prev) => prev ?? t?.id);
  }, [archives, draft]);

  useEffect(() => {
    if (!targetId) return;
    const target = archives.find((a) => a.id === targetId);
    if (!target) return;
    // 基线候选：期号小于本期的已发布档案中最新的一份（修订期优先于原期）
    const candidates = sortArchives(archives)
      .filter((a) => a.status !== 'draft' && a.roundNo < target.roundNo)
      .reverse();
    const autoBase = target.baseRoundId && archives.some((a) => a.id === target.baseRoundId)
      ? target.baseRoundId
      : candidates[0]?.id;
    setBaseId((prev) => prev ?? autoBase);
  }, [targetId, archives]);

  const target = archives.find((a) => a.id === targetId);
  const base = archives.find((a) => a.id === baseId);

  // 两个终端先后提交的乐观锁基线；本页保存后自行续号，切期或其他终端发布后随档案刷新
  const [targetVersionAtLoad, setTargetVersionAtLoad] = useState<number | undefined>(undefined);
  const selfBumpedRound = useRef<string | null>(null);

  // 切期时载入该期已保存的比对结果
  useEffect(() => {
    if (!targetId) {
      setDiffs([]);
      return;
    }
    let alive = true;
    selfBumpedRound.current = null;
    void loadRecheckDiffs(id, targetId).then((rows) => {
      if (!alive) return;
      setDiffs(rows);
      const t = useRoundStore.getState().getById(targetId);
      setTargetVersionAtLoad(t?.version);
    });
    return () => {
      alive = false;
    };
  }, [targetId, id]);

  // 其他终端改动（广播触发 store 重载）后同步版本基线；本页自己保存的不重置
  useEffect(() => {
    const t = archives.find((a) => a.id === targetId);
    if (!t) return;
    if (selfBumpedRound.current === targetId) return;
    setTargetVersionAtLoad(t.version);
  }, [archives, targetId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const targetTrees: TreeRecord[] = useMemo(
    () => (target ? snapshotTreesOrLive(target, liveTrees) : []),
    [target, liveTrees],
  );
  const baseTrees: TreeRecord[] = useMemo(
    () => (base ? snapshotTreesOrLive(base, liveTrees) : []),
    [base, liveTrees],
  );

  const targetEditable = target?.status === 'draft' && !target.locked;

  const generate = () => {
    if (!target || !base) {
      setError('请先选择上期与本期档案');
      return;
    }
    if (base.id === target.id) {
      setError('上期与本期不能是同一期档案');
      return;
    }
    const baseMap = new Map<string, TreeRecord>();
    baseTrees.forEach((t) => baseMap.set(t.treeNo, t));
    const targetMap = new Map<string, TreeRecord>();
    targetTrees.forEach((t) => targetMap.set(t.treeNo, t));
    const allNos = Array.from(new Set([...baseMap.keys(), ...targetMap.keys()])).sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN', { numeric: true }),
    );

    const now = Date.now();
    const next: RecheckDiff[] = allNos.map((treeNo) => {
      const b = baseMap.get(treeNo);
      const t = targetMap.get(treeNo);
      const baseDbh = b?.dbhCm;
      const targetDbh = t?.dbhCm;
      const dbhGrowth = baseDbh !== undefined && targetDbh !== undefined ? r2(targetDbh - baseDbh) : 0;
      const heightGrowth = b && t ? r2(t.heightM - b.heightM) : 0;
      const statusChange = b && t && b.status !== t.status ? `${b.status} → ${t.status}` : '';
      const missingReason = !t ? '本期未复测（疑似采伐或倒伏）' : !b ? '本期新增进界木' : '';
      return {
        id: newId('diff'),
        plotId: id,
        baseRound: base.roundNo,
        targetRound: target.roundNo,
        roundId: target.id,
        treeNo,
        species: t?.species ?? b?.species ?? '',
        baseDbhCm: baseDbh,
        targetDbhCm: targetDbh,
        baseHeightM: b?.heightM,
        targetHeightM: t?.heightM,
        dbhGrowth,
        heightGrowth,
        statusChange,
        missingReason,
        generatedAt: now,
      };
    });

    setDiffs(next);
    setError('');
    setToast(`已生成 ${roundArchiveLabel(base)} → ${roundArchiveLabel(target)} 的逐株比对表，共 ${next.length} 条`);
  };

  const save = async () => {
    if (!target) {
      setError('请先选择本期档案');
      return;
    }
    if (target.status !== 'draft') {
      setError('本期已发布归档，不能再写比对结果；如需更正请从该期「以此期修订」');
      return;
    }
    if (diffs.length === 0) {
      setError('请先生成比对表');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const expected = targetVersionAtLoad ?? target.version;
      // CAS：另一终端若已发布或改过草稿，version 对不上就整笔回滚，比对结果不会互相覆盖
      const nextVersion = await saveRecheckDiffsLocked(
        target.id,
        expected,
        diffs.map((d) => ({ ...d, roundId: target.id })),
      );
      selfBumpedRound.current = target.id;
      setTargetVersionAtLoad(nextVersion);
      useRoundStore.setState((s) => ({
        items: s.items.map((a) => (a.id === target.id ? { ...a, version: nextVersion } : a)),
      }));
      broadcastChange({ table: 'rechecks', plotId: id });
      broadcastChange({ table: 'rounds', plotId: id });
      setToast(`逐株比对表已随 ${roundArchiveLabel(target)} 保存（${diffs.length} 条），发布时将定格进快照`);
    } catch (e) {
      if (e instanceof ArchiveConflictError || e instanceof ArchiveLockedError) setError(e.message);
      else if (e instanceof Error && e.name === 'ArchiveConflictError') setError(e.message);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const abnormal = diffs.filter(isDiffAbnormal).length;
  const missing = diffs.filter((d) => !d.targetDbhCm).length;
  const retained = diffs.filter((d) => d.targetDbhCm);
  const avgRate =
    retained.length === 0 ? 0 : r2(retained.reduce((s, d) => s + growthRate(d), 0) / retained.length);

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

  const baseSelectable = sortArchives(archives).filter((a) => a.status !== 'draft');

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          复查比对 · {plot.plotNo}
        </Typography.Title>
        {target ? (
          <RoundTag
            round={target.roundNo}
            locked={target.locked}
            revisionSeq={target.revisionSeq}
            status={target.status}
          />
        ) : null}
        <Tag>样地面积 {plot.area} m²</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/regen`}>更新与灌木</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={12}>
        <Col span={15}>
          <Card size="small">
            <Space wrap size={10}>
              <span>
                上期（已发布快照）
                <Select
                  style={{ width: 210, marginLeft: 6 }}
                  value={baseId}
                  onChange={setBaseId}
                  options={baseSelectable.map((a) => ({ value: a.id, label: roundArchiveLabel(a) }))}
                />
              </span>
              <span>
                本期
                <Select
                  style={{ width: 210, marginLeft: 6 }}
                  value={targetId}
                  onChange={(v) => {
                    setTargetId(v);
                    setBaseId(undefined);
                  }}
                  options={targetOptions.map((a) => ({ value: a.id, label: roundArchiveLabel(a) }))}
                />
              </span>
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={generate}>
                生成逐株比对表
              </Button>
              <Button icon={<SaveOutlined />} loading={saving} disabled={!targetEditable} onClick={save}>
                保存到本期
              </Button>
            </Space>
            <div style={{ marginTop: 8 }}>
              {base && base.snapshot ? (
                <Typography.Text type="secondary">
                  上期基线为发布时定格的快照（{base.snapshot.trees.length} 株），之后原期再修订也不会改动本次比对。
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">请选择两份不同期次的档案。</Typography.Text>
              )}
              {target && target.status !== 'draft' ? (
                <Tag color="default" style={{ marginLeft: 8 }}>
                  本期为已发布档案，展示的是归档结果（只读）
                </Tag>
              ) : null}
            </div>
          </Card>

          <Row gutter={12} style={{ marginTop: 12 }}>
            <Col span={6}>
              <Card size="small">
                <Statistic title="比对数" value={diffs.length} suffix="株" />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="平均保留木生长率" value={avgRate} precision={2} suffix="%" />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="缺测 / 无法匹配" value={missing} suffix="株" />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="异常标注" value={abnormal} suffix="条" />
              </Card>
            </Col>
          </Row>

          <Card size="small" title="两期逐株差值表" style={{ marginTop: 12 }}>
            <GrowthDiffTable diffs={diffs} />
          </Card>
        </Col>
        <Col span={9}>
          <ArchiveTimeline
            plotId={id}
            archives={archives}
            currentId={target?.id}
            onView={setSnapshot}
            onChanged={() => {
              // 发布/开新期/修订后，比对页随最新档案重取
              setDiffs([]);
              setTargetId(undefined);
              setBaseId(undefined);
              void reloadAfterRoundChange(id);
            }}
          />
        </Col>
      </Row>

      <SnapshotViewer archive={snapshot} onClose={() => setSnapshot(null)} />
    </Space>
  );
}

/** 已发布档案读快照行；草稿读活动行 */
function snapshotTreesOrLive(archive: RoundArchive, liveTrees: TreeRecord[]): TreeRecord[] {
  if (archive.snapshot) return snapshotTrees(archive);
  return liveTrees
    .filter((t) => t.roundId === archive.id)
    .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
}
