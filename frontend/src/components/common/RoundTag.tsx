import { Tag, Tooltip } from 'antd';
import type { RoundStatus } from '../../types/roundArchive';

export interface RoundTagProps {
  round: number;
  locked?: boolean;
  /** 修订次序（原期为 0） */
  revisionSeq?: number;
  status?: RoundStatus;
  /** 来源期号（修订期用） */
  sourceRoundNo?: number | null;
}

/** 复查期次角标：草稿 / 已发布 / 修订期 / 锁定，被台账、录入页、复查页消费 */
export default function RoundTag({ round, locked = false, revisionSeq = 0, status, sourceRoundNo }: RoundTagProps) {
  const isDraft = status === 'draft';
  const isRevision = status === 'revision';
  const color = isDraft ? 'orange' : isRevision ? 'purple' : round > 1 ? 'geekblue' : 'default';
  const parts = [`第 ${round} 期`];
  if (isDraft) parts.push('未发布草稿');
  else if (isRevision || revisionSeq > 0) parts.push(`修订 ${revisionSeq}`);
  if (locked) parts.push('已锁定');

  const tip = isRevision
    ? `修订期，来源：第 ${sourceRoundNo ?? round} 期档案；原期快照仍可查`
    : isDraft
      ? '草稿数据未归档，不会作为下一期的依据'
      : locked
        ? '该期已发布归档并锁定'
        : '该期已发布归档，修改请走修订期';

  return (
    <Tooltip title={tip}>
      <Tag color={color} data-testid={`round-tag-${round}`}>
        {parts.join(' · ')}
      </Tag>
    </Tooltip>
  );
}
