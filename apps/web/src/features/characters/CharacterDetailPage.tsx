import { useParams } from 'react-router';
import { CharacterDetail } from './detail/CharacterDetail';

/**
 * 角色详情 `/characters/:id` —— 设计说明见 docs/FRONTEND.md「4. 角色详情」。
 *
 * 按 id 加 key：从「常一起出现」点到另一个角色时整页重新挂载，
 * 不会把上一个角色的图片（keepPreviousData）或选择状态带过来。
 */
export function CharacterDetailPage() {
  const { id = '' } = useParams();
  return <CharacterDetail key={id} id={id} />;
}
