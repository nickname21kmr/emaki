/**
 * 编目的反应：角色改名、合并、绑定变了（包括撤销这些操作）之后，重算「自建角色能对上 Danbooru」
 * （docs/core-architecture.md 第 5.2 节 recomputeCustomMatches，以前 5 处手工调用）。
 * recomputeCustomMatches 自己开事务，放在提交后。characterIds 为空表示全部重算（后台自动关联）。
 */
import type { DanbooruCatalog } from '../../services/danbooru/catalog.ts';
import { recomputeCustomMatches } from './customMatches.ts';
import type { Reaction } from '../../propagation/registry.ts';

export function catalogReactions(danbooru: () => DanbooruCatalog | undefined): Reaction[] {
  return [
    {
      name: 'recomputeCustomMatches',
      on: ['catalog.characterChanged', 'catalog.merged', 'catalog.bindingChanged'],
      phase: 'after',
      run({ ctx, changes }) {
        const d = danbooru();
        if (!d) return;
        const everything = changes.list.some((c) => 'characterIds' in c && !c.characterIds.length);
        recomputeCustomMatches(ctx.db, d, everything ? undefined : changes.characterIds());
      },
    },
  ];
}
