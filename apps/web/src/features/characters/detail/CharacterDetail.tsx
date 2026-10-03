import type { ID } from '@emaki/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { PageBody } from '@/components/layout/PageHeader';
import { ImageGridSkeleton } from '@/components/media/ImageGrid';
import { CollectionsStrip } from '@/components/media/CollectionsStrip';
import { Thumb } from '@/components/media/Thumb';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { useCharacter, useMutate } from '@/lib/queries';
import { CharacterHero, CharacterHeroSkeleton } from './CharacterHero';
import { CharacterImages } from './CharacterImages';
import { CoverPickerDialog } from './CoverPickerDialog';
import { DetailHeader, type Crumb } from './DetailHeader';
import { EditCharacterDialog } from './EditCharacterDialog';
import { ExcludeCharacterDialog } from './ExcludeCharacterDialog';
import { MergeCharacterDialog } from './MergeCharacterDialog';
import { folderNameOf, MoveImagesDialog } from '@/components/media/MoveImagesDialog';
import { RelatedCharacters, RelatedCharactersSkeleton } from './RelatedCharacters';
import { useInView } from './useInView';

type DialogKind = 'edit' | 'merge' | 'move' | 'exclude' | 'cover' | null;

/**
 * 角色详情。外层按 id 加 key 挂载，切换角色时所有局部状态（选择、弹窗、记下的 +N）自动重置。
 */
export function CharacterDetail({ id }: { id: ID }) {
  const navigate = useNavigate();
  const { data, isPending, isPlaceholderData, isError, error, refetch } = useCharacter(id);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const heroRef = useRef<HTMLElement>(null);
  const imagesRef = useRef<HTMLElement>(null);
  // 扣掉吸顶头部的高度：Hero 被头部完全盖住时才显示头部小头像
  const heroVisible = useInView(heroRef, { rootMargin: '-72px 0px 0px 0px', enabled: !!data });
  const newSinceLastVisit = useMarkSeen(id, data?.character.newCount);

  const pin = useMutate((pinned: boolean) => api.updateCharacter(id, { pinned }));
  const restoreCover = useMutate(() => api.updateCharacter(id, { coverImageId: null }));

  const character = data?.character;
  const mainWork = data?.works[0];
  const crumbs: Crumb[] = [
    { label: '角色', to: '/characters' },
    ...(mainWork ? [{ label: mainWork.name, to: `/works/${mainWork.id}` }] : []),
  ];

  const header = (
    <DetailHeader
      crumbs={crumbs}
      current={
        character?.name ?? (
          <span className="inline-block h-5 w-28 skeleton rounded-md align-middle" aria-label="加载中" />
        )
      }
      showAvatar={!heroVisible}
      avatar={
        character?.coverImageId ? (
          <Thumb
            image={{ id: character.coverImageId, dominantColor: mainWork?.color ?? 'var(--c-sunken)', rating: character.coverRating }}
            width={240}
            focus={character.coverFocus}
            className="size-7 rounded-[8px] ring-1 ring-line"
          />
        ) : null
      }
    />
  );

  if (isError) {
    const notFound = error instanceof ApiRequestError && error.code === 'not_found';
    return (
      <>
        {header}
        <PageBody>
          {notFound ? (
            <EmptyState
              glyph="无"
              title="找不到这个角色"
              description="它可能已经被合并进别的角色，或者被删除了。"
              action={
                <Button variant="primary" size="sm" onClick={() => navigate('/characters')}>
                  回到角色列表
                </Button>
              }
            />
          ) : (
            <ErrorState error={error} onRetry={() => void refetch()} />
          )}
        </PageBody>
      </>
    );
  }

  if (isPending || !character) {
    return (
      <>
        {header}
        <PageBody className="flex flex-col gap-10">
          <CharacterHeroSkeleton />
          <RelatedCharactersSkeleton />
          <section>
            <div className="mb-4 flex items-center justify-between">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-7 w-80 rounded-full" />
            </div>
            <ImageGridSkeleton rows={3} rowHeight={220} />
          </section>
        </PageBody>
      </>
    );
  }

  const coverHelp = () => {
    imagesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('更换封面', {
      description: '在下面的插画里选中一张（悬停时点左上角的圆圈），底部工具栏会出现「设为封面」。',
    });
  };

  return (
    <>
      {header}
      <PageBody className="flex flex-col gap-10">
        <CharacterHero
          character={character}
          works={data.works}
          related={data.related}
          newSinceLastVisit={newSinceLastVisit}
          heroRef={heroRef}
          onTogglePin={() => pin.mutate(!character.pinned)}
          pinPending={pin.isPending}
          onEdit={() => setDialog('edit')}
          onMerge={() => setDialog('merge')}
          onMove={() => setDialog('move')}
          onExclude={() => setDialog('exclude')}
          onChangeCover={() => setDialog('cover')}
          onRestoreCover={() => restoreCover.mutate()}
        />
        {/* 先用列表缓存顶上的那一帧还没有「常一起出现」（SEL-14） */}
        {isPlaceholderData ? <RelatedCharactersSkeleton /> : <RelatedCharacters related={data.related} name={character.name} />}
        <CollectionsStrip characterId={id} />
        <CharacterImages
          character={character}
          newSinceLastVisit={newSinceLastVisit}
          sectionRef={imagesRef}
          dialogOpen={dialog !== null}
        />
      </PageBody>

      <EditCharacterDialog open={dialog === 'edit'} onOpenChange={(o) => setDialog(o ? 'edit' : null)} character={character} />
      <MergeCharacterDialog
        open={dialog === 'merge'}
        onOpenChange={(o) => setDialog(o ? 'merge' : null)}
        character={character}
      />
      <CoverPickerDialog
        open={dialog === 'cover'}
        onOpenChange={(o) => setDialog(o ? 'cover' : null)}
        character={character}
        tint={mainWork?.color ?? 'var(--c-sunken)'}
        onPickFromAll={coverHelp}
      />
      <MoveImagesDialog
        open={dialog === 'move'}
        onOpenChange={(o) => setDialog(o ? 'move' : null)}
        target={{ characterId: character.id }}
        count={character.imageCount + character.otherCount}
        what={`「${character.name}」的`}
        defaultDir={folderNameOf(character.name)}
      />
      <ExcludeCharacterDialog
        open={dialog === 'exclude'}
        onOpenChange={(o) => setDialog(o ? 'exclude' : null)}
        character={character}
      />
    </>
  );
}

/**
 * 进入页面时清掉「+N」（api.markCharacterSeen），但先把 N 记下来给 Hero 和「新」角标用——
 * 清零后后端会推 library-changed，角色数据重新拉取时 newCount 已经是 0 了。
 *
 * 这里直接调 api 而不是 useMutate：它没有 MutationResult、不需要 toast / 撤销，刷新由 SSE 负责。
 */
function useMarkSeen(id: ID, newCount: number | undefined): number {
  const [entry, setEntry] = useState<number | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (newCount === undefined || done.current) return;
    done.current = true;
    setEntry(newCount);
    api.markCharacterSeen(id).catch(() => {
      // 清角标失败不影响浏览，下次进来再试
    });
  }, [id, newCount]);

  return entry ?? newCount ?? 0;
}
