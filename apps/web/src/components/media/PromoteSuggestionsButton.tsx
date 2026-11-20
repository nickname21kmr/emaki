import type { ContentKind } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { useCapabilities } from '@/lib/capabilities';
import { formatCount } from '@/lib/format';
import { useMutate } from '@/lib/queries';

/**
 * 「按当前阈值补采纳」：服务端的补采纳命令（对达标建议所在的图跑一遍自动决定规则，只新增，可撤销）。
 * 预览数和执行是同一轮评估。预览是 settings 的查询、补采纳是 rules 的命令（lib/capabilities.ts）：两样都有才显示，没有时也不去问
 */
export function PromoteSuggestionsButton({ threshold, kind }: { threshold?: number; kind?: ContentKind }) {
  const { known } = useCapabilities();
  const allowed = known('settings') && known('rules');
  const { data } = useQuery({
    queryKey: ['tagger', 'promotable', threshold, kind],
    queryFn: () => api.promotableSuggestions(kind),
    enabled: allowed,
  });
  const promote = useMutate(() => api.promoteSuggestions(kind), { label: '补采纳' });
  if (!allowed || !data?.images || (threshold !== undefined && data.threshold !== threshold)) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={promote.isPending}
      title={`按现在的阈值重新评估这些图的建议，达标的归到角色（${formatCount(data.suggestions)} 条），可撤销`}
      onClick={() => promote.mutate(undefined)}
    >
      补采纳 {formatCount(data.images)} 张图的角色建议
    </Button>
  );
}
