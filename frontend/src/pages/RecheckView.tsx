import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Tag, Typography } from 'antd';
import { PlusOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useArchiveStore } from '../stores/archiveStore';
import GrowthDiffTable from '../components/common/GrowthDiffTable';
import RoundTag from '../components/common/RoundTag';
import { loadRecheckDiffs, replaceRecheckDiffs } from '../utils/db';
import { buildRecheckDiffs } from '../utils/recheck';
import { growthRate, isDiffAbnormal, type RecheckDiff } from '../types/recheck';
import { treesOfRound } from '../utils/roundData';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** /plots/:id/recheck 复查比对：逐株显示两期胸径/树高与生长量，标记缺失与状态变化 */
export default function RecheckView() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const trees = useTreeStore((s) => s.items);
  const archivesAll = useArchiveStore((s) => s.items);
  const busy = useArchiveStore((s) => s.busy);
  const publishDraft = useArchiveStore((s) => s.publishDraft);
  const startNextRound = useArchiveStore((s) => s.startNextRound);

  const archives = useMemo(
    () => archivesAll.filter((a) => a.plotId === id).sort((a, b) => a.round - b.round),
    [archivesAll, id],
  );
  const rounds = archives.map((a) => a.round);
  const archiveOf = (round: number) => archives.find((a) => a.round === round);

  const [baseRound, setBaseRound] = useState<number>(rounds.length > 1 ? rounds[rounds.length - 2] : 1);
  const [targetRound, setTargetRound] = useState<number>(plot?.surveyRound ?? rounds[rounds.length - 1] ?? 1);
  const [diffs, setDiffs] = useState<RecheckDiff[]>([]);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (rounds.length >= 2) {
      setBaseRound(rounds[rounds.length - 2]);
      setTargetRound(rounds[rounds.length - 1]);
    } else if (rounds.length === 1) {
      setTargetRound(rounds[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds.join(','), plot?.id]);

  const targetArchive = archiveOf(targetRound);
  const targetPublished = targetArchive?.status === 'published';

  // 载入该「本期」已保存 / 已冻结的比对结果
  useEffect(() => {
    if (!id) return;
    let alive = true;
    if (targetPublished && targetArchive) {
      const frozen = [...targetArchive.rechecks].sort((a, b) =>
        a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }),
      );
      setDiffs(frozen);
      return () => {
        alive = false;
      };
    }
    void loadRecheckDiffs(id, targetRound).then((rows) => {
      if (alive) setDiffs(rows);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, targetRound, targetPublished, targetArchive?.publishedAt, targetArchive?.rechecks.length]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const generate = () => {
    if (baseRound === targetRound) {
      setError('上期与本期不能是同一期次');
      return;
    }
    const baseList = treesOfRound(archivesAll, trees, id, baseRound);
    const targetList = treesOfRound(archivesAll, trees, id, targetRound);
    const next = buildRecheckDiffs(id, baseRound, targetRound, baseList, targetList);
    setDiffs(next);
    setError('');
    setToast(`已生成第 ${baseRound} 期 → 第 ${targetRound} 期的逐株比对表，共 ${next.length} 条`);
  };

  const save = async () => {
    if (diffs.length === 0) {
      setError('请先生成比对表');
      return;
    }
    if (targetPublished) {
      setError('本期已发布归档，比对结果已冻结；如需更正请从本期生成修订期');
      return;
    }
    await replaceRecheckDiffs(id, targetRound, diffs);
    setToast(`逐株比对表已保存到第 ${targetRound} 期草稿，发布时随快照冻结（${diffs.length} 条）`);
  };

  const abnormal = diffs.filter(isDiffAbnormal).length;
  const missing = diffs.filter((d) => !d.targetDbhCm).length;
  const matched = diffs.filter((d) => d.targetDbhCm);
  const avgRate =
    matched.length === 0 ? 0 : r2(matched.reduce((s, d) => s + growthRate(d), 0) / matched.length);

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
          复查比对 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={targetRound} locked={targetArchive?.locked ?? plot.locked} archive={targetArchive} />
        {targetArchive?.sourceRound ? <Tag color="purple">修订自第 {targetArchive.sourceRound} 期</Tag> : null}
        <Tag>样地面积 {plot.area} m²</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/regen`}>更新与灌木</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/archives`}>期次档案</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {targetPublished ? (
        <Alert
          type="info"
          showIcon
          message={`下表是第 ${targetRound} 期发布时冻结的两期比对结果，只读不可改；修订后请另开修订期。`}
        />
      ) : (
        <Alert
          type="warning"
          showIcon
          message={`第 ${targetRound} 期还是草稿：先「保存比对结果」，再发布本期，比对结果才会随档案冻结。`}
        />
      )}

      <Card size="small">
        <Space wrap size={10}>
          <span>
            上期
            <Select
              style={{ width: 120, marginLeft: 6 }}
              value={baseRound}
              onChange={setBaseRound}
              options={rounds.map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          <span>
            本期
            <Select
              style={{ width: 120, marginLeft: 6 }}
              value={targetRound}
              onChange={setTargetRound}
              options={rounds.map((r) => ({ value: r, label: `第 ${r} 期` }))}
            />
          </span>
          <Button type="primary" onClick={generate}>
            生成逐株比对表
          </Button>
          <Button icon={<SaveOutlined />} onClick={save} disabled={targetPublished}>
            保存比对结果
          </Button>
          {!targetPublished ? (
            <Button
              ghost
              type="primary"
              icon={<SendOutlined />}
              loading={!!busy[`pub:${id}:${targetRound}`]}
              onClick={async () => {
                try {
                  await publishDraft(id, targetRound);
                  setToast(`第 ${targetRound} 期已发布归档，比对结果已冻结`);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              发布本期
            </Button>
          ) : (
            <Button
              icon={<PlusOutlined />}
              loading={!!busy[`next:${id}`]}
              onClick={async () => {
                try {
                  const r = await startNextRound(id);
                  setTargetRound(r.archive.round);
                  setToast(
                    r.reused
                      ? `第 ${r.archive.round} 期草稿已存在，请继续录入`
                      : `已基于最近一次已发布快照开出第 ${r.archive.round} 期草稿`,
                  );
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              以已发布快照新开下一期
            </Button>
          )}
          <Typography.Text type="secondary">
            可选期次：{rounds.length === 0 ? '暂无数据' : rounds.map((r) => `第 ${r} 期`).join('、')}
          </Typography.Text>
        </Space>
      </Card>

      <Row gutter={12}>
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

      <Card size="small" title="两期逐株差值表">
        <GrowthDiffTable diffs={diffs} />
      </Card>
    </Space>
  );
}
