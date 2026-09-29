import { Tag, Tooltip } from 'antd';
import type { RoundArchive } from '../../types/archive';

export interface RoundTagProps {
  round: number;
  locked?: boolean;
  /** 期次档案：给出后展示草稿/已发布与修订来源 */
  archive?: RoundArchive;
}

/** 复查期次角标，被样地台账、各期页面消费 */
export default function RoundTag({ round, locked = false, archive }: RoundTagProps) {
  const isDraft = archive?.status === 'draft';
  const label = `第 ${round} 期${isDraft ? ' · 草稿' : archive ? ' · 已发布' : ''}${locked ? ' · 已锁定' : ''}`;

  const tag = (
    <Tag
      color={isDraft ? 'gold' : round > 1 ? 'geekblue' : 'default'}
      data-testid={`round-tag-${round}`}
    >
      {label}
    </Tag>
  );

  if (archive?.sourceRound) {
    return (
      <Tooltip title={`修订期：来源于第 ${archive.sourceRound} 期，原快照仍可在档案页查阅`}>
        {tag}
      </Tooltip>
    );
  }
  return tag;
}
