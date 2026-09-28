import { useParams } from 'react-router';
import { WorkDetail } from './components/WorkDetail';

/**
 * 作品 `/works/:id` —— 设计说明见 docs/FRONTEND.md「5. 作品」。
 * 按 id 加 key：换作品时整页重新挂载，不会带着上一部作品的图片或选择。
 */
export function WorkDetailPage() {
  const { id = '' } = useParams();
  return <WorkDetail key={id} id={id} />;
}
