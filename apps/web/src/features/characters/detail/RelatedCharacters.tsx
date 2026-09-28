import type { GetCharacterResponse } from '@emaki/shared';
import { motion } from 'motion/react';
import { AvatarTile } from '@/components/media/AvatarTile';
import { Badge, SectionTitle, Skeleton } from '@/components/ui';
import { formatCount } from '@/lib/format';
import { EASE_OUT } from '@/lib/motion';

type Related = GetCharacterResponse['related'];

/**
 * 「常一起出现」（BR-3）：扉页下面的第一章，一行圆头像，图注是同框张数；有新图的带「+N」。
 */
export function RelatedCharacters({ related, name }: { related: Related; name: string }) {
  if (related.length === 0) return null;
  return (
    <section aria-label="常一起出现的角色">
      <SectionTitle hint={`和${name}出现在同一张图里`}>常一起出现</SectionTitle>
      <div className="-mx-8 flex gap-4 overflow-x-auto px-8 pt-3.5 pb-3 fade-x scrollbar-none">
        {related.map(({ character, sharedCount }, i) => (
          <motion.div
            key={character.id}
            className="shrink-0"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.12 + i * 0.035 }}
          >
            <AvatarTile
              character={character}
              caption={`同框 ${formatCount(sharedCount)} 张`}
              badge={
                character.newCount > 0 ? (
                  <Badge tone="ink" dot="var(--c-ok)">
                    +{formatCount(character.newCount)}
                  </Badge>
                ) : undefined
              }
            />
          </motion.div>
        ))}
      </div>
    </section>
  );
}

export function RelatedCharactersSkeleton() {
  return (
    <section>
      <Skeleton className="mb-3 h-4 w-24" />
      <div className="flex gap-4 overflow-hidden pt-3.5 pb-3">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="flex w-[116px] shrink-0 flex-col items-center">
            <Skeleton className="size-[92px] rounded-full" />
            <Skeleton className="mt-4 h-3 w-14" />
            <Skeleton className="mt-2 h-2.5 w-10" />
          </div>
        ))}
      </div>
    </section>
  );
}
