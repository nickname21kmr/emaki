import type { ContentKind } from '@emaki/shared';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { useMutate } from '@/lib/queries';

export function PromoteSuggestionsButton({ threshold, kind }: { threshold?: number; kind?: ContentKind }) {
  const { data } = useQuery({
    queryKey: ['tagger', 'promotable', threshold, kind],
    queryFn: () => api.promotableSuggestions(kind),
  });
  const promote = useMutate(() => api.promoteSuggestions(kind));
  if (!data?.images || (threshold !== undefined && data.threshold !== threshold)) return null;
  return (
    <Button size="sm" variant="secondary" loading={promote.isPending} onClick={() => promote.mutate(undefined)}>
      补采纳 {formatCount(data.images)} 张图的角色建议
    </Button>
  );
}
