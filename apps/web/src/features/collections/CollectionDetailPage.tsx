import type { CollectionKind, GetCollectionResponse, ID, ImageItem, Rating } from '@emaki/shared';
import {
  ArrowDownAZ,
  BookOpenText,
  CalendarClock,
  Check,
  CircleMinus,
  CircleOff,
  Ellipsis,
  FolderInput,
  FolderOpen,
  Heart,
  HeartOff,
  ImagePlus,
  ImageUp,
  Layers,
  Palette,
  PencilLine,
  Play,
  RotateCcw,
  ShieldHalf,
  Trash2,
  UserRoundPlus,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { AvatarTile } from '@/components/media/AvatarTile';
import { BookPlate } from '@/components/media/BookPlate';
import { AddToGroupDialog } from '@/components/media/CollectionControls';
import { CoverFan } from '@/components/media/CoverFan';
import { ImageGrid, ImageGridSkeleton } from '@/components/media/ImageGrid';
import { collectImages, slideFilter, useSlideshow } from '@/components/media/lightbox/slideshow';
import {
  Badge,
  Button,
  Chip,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  SectionTitle,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { byline, COLLECTION_META, displayTitle, groupOrigin, readProgress, unitWord } from '@/lib/collections';
import { formatCount, formatRelative, RATING_LABEL } from '@/lib/format';
import { useCollection, useImagesInfinite, useMutate } from '@/lib/queries';
import { ArtistBulkPicker } from '@/features/gallery/ArtistPicker';
import { CharacterPicker } from '@/features/gallery/CharacterPicker';
import { WorkPicker } from '@/features/characters/detail/WorkPicker';
import { SelectionBar, type SelectionAction } from '@/features/characters/detail/SelectionBar';
import { useScopedSelection } from '@/features/characters/detail/useScopedSelection';
import { CollectionImagePicker } from './components/CollectionImagePicker';

const RATINGS: Rating[] = ['general', 'sensitive', 'questionable', 'explicit'];

/**
 * 一本合集（T38d）：扉页（书 + 奥付）→ 01 出场角色 → 02 目次。
 * 点目次里的一页进阅读器；多选可以归到角色、设分级，只选一张时能设为封面。
 */
export function CollectionDetailPage() {
  const { id = '' } = useParams();
  const q = useCollection(id);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <DetailSkeleton />;
  // 按 id 重新挂载：在系列里跳来跳去时，弹窗、选择这些局部状态不带到下一本
  return <Detail key={id} data={q.data} />;
}

function Detail({ data }: { data: GetCollectionResponse }) {
  const c = data.collection;
  const m = COLLECTION_META[c.kind];
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'rename' | 'series' | 'works' | null>(null);
  const update = useMutate((body: Parameters<typeof api.updateCollection>[1]) => api.updateCollection(c.id, body));
  const dismiss = useMutate(() => api.deleteCollection(c.id), { onSuccess: () => navigate('/collections') });
  const progress = readProgress.get(c.id);
  const [adding, setAdding] = useState(false);
  // 按文件夹成册的跟着文件夹走：不能加别处的图（手选的组图改成本子 / 画集后可以）
  const folder = c.membership === 'folder';
  const manualChars = data.cast.filter((x) => x.manual).map((x) => x.character.id);
  const manualWorks = data.works.filter((x) => x.manual).map((x) => x.work.id);

  if (c.kind === 'group') return <GroupDetail data={data} />;

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        kicker={
          <>
            <span className="font-semibold text-shu-fg">{m.label}</span>
            {c.event && <span className="ml-3">{c.event}</span>}
          </>
        }
        title={displayTitle(c)}
        subtitle={[`${formatCount(c.pageCount)} 页`, byline(c)].filter(Boolean).join(' · ')}
        actions={
          <>
            {progress && progress > 1 && (
              <Button variant="ghost" size="sm" onClick={() => navigate(`/collections/${c.id}/read?p=${progress}`)}>
                继续读 · 第 {progress} 页
              </Button>
            )}
            <Button variant="primary" size="sm" icon={<BookOpenText className="size-3.5" />} onClick={() => navigate(`/collections/${c.id}/read?p=1`)}>
              从头读
            </Button>
            <Menu
              width={220}
              trigger={
                <Button variant="ghost" size="sm" aria-label="更多">
                  <Ellipsis className="size-4" />
                </Button>
              }
            >
              <MenuItem icon={<PencilLine />} onSelect={() => setDialog('rename')}>
                改名…
              </MenuItem>
              <KindSub kind={c.kind} onChange={(kind) => update.mutate({ kind })} />
              {folder ? (
                <MenuItem icon={<RotateCcw />} onSelect={() => update.mutate({ kind: 'auto' })}>
                  恢复自动判断类型
                </MenuItem>
              ) : (
                <MenuItem icon={<ImagePlus />} onSelect={() => setAdding(true)}>
                  添加图片…
                </MenuItem>
              )}
              <MenuSub label="页序" icon={<ArrowDownAZ />}>
                <MenuRadioGroup value={data.pageOrder} onValueChange={(v) => update.mutate({ pageOrder: v as 'name' | 'mtime' })}>
                  <MenuRadioItem value="name">按文件名</MenuRadioItem>
                  <MenuRadioItem value="mtime">按文件修改时间</MenuRadioItem>
                </MenuRadioGroup>
              </MenuSub>
              <MenuItem icon={<Layers />} onSelect={() => setDialog('series')}>
                归入系列…
              </MenuItem>
              <MenuItem
                icon={<FolderOpen />}
                onSelect={() => data.pages[0] && void api.revealImage(data.pages[0].imageId).catch(() => undefined)}
              >
                在资源管理器中显示
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<CircleOff />} danger onSelect={() => dismiss.mutate()}>
                {folder ? '不成册' : '解散（图片都还在）'}
              </MenuItem>
            </Menu>
          </>
        }
      />
      {adding && <CollectionImagePicker id={c.id} memberIds={data.pages.map((p) => p.imageId)} open={adding} onOpenChange={setAdding} />}
      <PageBody className="flex-1">
        <section className="mt-2 grid grid-cols-[240px_minmax(0,1fr)] gap-10 max-[900px]:grid-cols-1">
          <BookPlate collection={c} size="lg" />
          <Colophon data={data} onReview={(v) => update.mutate({ reviewed: v })} />
        </section>

        <section className="mt-14">
          <SectionTitle
            hint={`${data.cast.length} 位`}
            actions={
              <>
                <CharacterPicker
                  title="关联角色"
                  meta="整本"
                  align="end"
                  onPick={(ch) => !manualChars.includes(ch.id) && update.mutate({ manualCharacterIds: [...manualChars, ch.id] })}
                >
                  <Button variant="ghost" size="sm" icon={<UserRoundPlus className="size-3.5" />}>
                    关联角色…
                  </Button>
                </CharacterPicker>
                <Button variant="ghost" size="sm" onClick={() => setDialog('works')}>
                  作品…
                </Button>
              </>
            }
          >
            出场角色
          </SectionTitle>
          {data.cast.length ? (
            <div className="flex flex-wrap gap-5 pt-3.5">
              {data.cast.map(({ character, pageCount, manual }) => (
                <div key={character.id} className="group/cast relative">
                  <AvatarTile
                    character={character}
                    badge={
                      <Badge tone="glass" className="gap-1 tabular">
                        {manual && <span className="size-1.5 rounded-full bg-shu" />}
                        {pageCount} 页
                      </Badge>
                    }
                  />
                  {manual && (
                    <button
                      type="button"
                      aria-label={`取消关联 ${character.name}`}
                      onClick={() => update.mutate({ manualCharacterIds: manualChars.filter((x) => x !== character.id) })}
                      className="absolute top-1 right-3 hidden size-6 items-center justify-center rounded-full bg-raised text-fg-muted shadow-lift ring-1 ring-line group-hover/cast:flex hover:text-fg"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-fg-muted">
              {c.kind === 'doujin' ? '还没有认出出场角色。可以整本关联一位角色，不会改动任何张数。' : '画集里的图还没有归到角色。'}
            </p>
          )}
        </section>

        <TableOfContents data={data} />
      </PageBody>

      <RenameDialog open={dialog === 'rename'} onOpenChange={(o) => !o && setDialog(null)} current={c.title} allowAuto={folder} onSave={(title) => update.mutate({ title })} />
      <SeriesDialog
        open={dialog === 'series'}
        onOpenChange={(o) => !o && setDialog(null)}
        seriesKey={c.seriesKey}
        volumeNo={c.volumeNo}
        onSave={(seriesKey, volumeNo) => update.mutate(seriesKey === null ? { seriesKey: null } : { seriesKey, volumeNo })}
      />
      <Dialog open={dialog === 'works'} onOpenChange={(o) => !o && setDialog(null)} title="整本关联作品" description="只写在合集上，不改任何张数。">
        <WorkPicker value={manualWorks} onChange={(ids) => update.mutate({ manualWorkIds: ids })} />
      </Dialog>
    </div>
  );
}

/** 打开方式（类型）：三选一。本子会整本处理，图不再逐张进「未识别」，所以在这里说清楚 */
function KindSub({ kind, onChange }: { kind: CollectionKind; onChange: (kind: CollectionKind) => void }) {
  return (
    <MenuSub label="类型" icon={<BookOpenText />}>
      <MenuLabel>本子整本处理，页不再逐张进「未识别」</MenuLabel>
      <MenuRadioGroup value={kind} onValueChange={(v) => v !== kind && onChange(v as CollectionKind)}>
        {(['doujin', 'artbook', 'group'] as const).map((k) => (
          <MenuRadioItem key={k} value={k}>
            {COLLECTION_META[k].label}
            <span className="ml-2 text-[11.5px] text-fg-subtle">{k === 'group' ? '网格浏览' : '按页读'}</span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuSub>
  );
}

/**
 * 组图（kind=group）：收在一起的散图。结构和本子的扉页一致：页头、扇形封面 + 细线表、出场角色、图片网格。
 * 不进阅读器：点图打开看图器，「放映」整组播放。
 */
function GroupDetail({ data }: { data: GetCollectionResponse }) {
  const c = data.collection;
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'rename' | 'add' | 'organize' | null>(null);
  const close = (o: boolean) => !o && setDialog(null);
  const update = useMutate((body: Parameters<typeof api.updateCollection>[1]) => api.updateCollection(c.id, body));
  const organize = useMutate(() => api.updateCollection(c.id, { organizeFiles: true }), { onSuccess: () => setDialog(null) });
  const dismiss = useMutate(() => api.deleteCollection(c.id), { onSuccess: () => navigate('/collections?kind=group') });
  const { start, pending } = useSlideshow();
  const names = data.cast.slice(0, 2).map((x) => x.character.name);
  const castLine = names.length ? names.join('、') + (data.cast.length > 2 ? ` 等 ${data.cast.length} 位` : '') : null;

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        kicker={
          <>
            <span className="font-semibold text-shu-fg">组图</span>
            <span className="ml-3">{groupOrigin(c)}</span>
          </>
        }
        title={displayTitle(c)}
        subtitle={[`${formatCount(c.pageCount)} 张`, castLine].filter(Boolean).join(' · ')}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ImagePlus className="size-3.5" />} onClick={() => setDialog('add')}>
              添加图片…
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Play className="size-3.5" />}
              loading={pending}
              onClick={() => start(() => collectImages([{ ...slideFilter(), collectionId: c.id, sort: 'page', order: 'asc' }], 500))}
            >
              放映
            </Button>
            <Menu
              width={220}
              trigger={
                <Button variant="ghost" size="sm" aria-label="更多">
                  <Ellipsis className="size-4" />
                </Button>
              }
            >
              <MenuItem icon={<PencilLine />} onSelect={() => setDialog('rename')}>
                改名…
              </MenuItem>
              <KindSub kind={c.kind} onChange={(kind) => update.mutate({ kind })} />
              <MenuItem icon={<FolderInput />} onSelect={() => setDialog('organize')}>
                整理到子文件夹…
              </MenuItem>
              <MenuItem
                icon={<FolderOpen />}
                onSelect={() => data.pages[0] && void api.revealImage(data.pages[0].imageId).catch(() => undefined)}
              >
                在资源管理器中显示
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<CircleOff />} danger onSelect={() => dismiss.mutate()}>
                解散组图（图片都还在）
              </MenuItem>
            </Menu>
          </>
        }
      />
      <PageBody className="flex-1">
        <section className="mt-2 grid grid-cols-[300px_minmax(0,1fr)] items-center gap-10 max-[900px]:grid-cols-1">
          <div className="group/fan mx-auto w-full max-w-[300px]">
            <CoverFan covers={c.covers} label={displayTitle(c)} bigCenter />
          </div>
          <GroupFacts data={data} />
        </section>

        {data.cast.length > 0 && (
          <section className="mt-14">
            <SectionTitle hint={`${data.cast.length} 位 · 按图上认出的角色`}>出场角色</SectionTitle>
            <div className="flex flex-wrap gap-5 pt-3.5">
              {data.cast.map(({ character, pageCount }) => (
                <AvatarTile key={character.id} character={character} badge={<Badge tone="glass">{pageCount} 张</Badge>} />
              ))}
            </div>
          </section>
        )}

        <TableOfContents data={data} />
      </PageBody>

      {dialog === 'add' && (
        <CollectionImagePicker id={c.id} memberIds={data.pages.map((p) => p.imageId)} open onOpenChange={close} />
      )}
      <RenameDialog
        open={dialog === 'rename'}
        onOpenChange={close}
        current={c.title}
        placeholder="组图名"
        allowAuto={false}
        onSave={(title) => title && update.mutate({ title })}
      />
      <Dialog
        open={dialog === 'organize'}
        onOpenChange={close}
        title="整理到子文件夹"
        description="磁盘上的文件会真的移动。可以撤销，也能在「设置 → 最近的移动」里移回。"
        width={460}
      >
        <div className="space-y-2.5 text-[13px] leading-relaxed text-fg-muted">
          <p>
            每个原文件夹里属于这组的图，移进同一个子文件夹「<span className="font-medium text-fg">{organizeFolderName(c.title)}</span>
            」；不同文件夹分别整理，不会合到一起。
          </p>
          <p>某个文件夹里只有一张的，原地不动。正在扫描或识别这些图时，会请你等它做完。</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDialog(null)}>
            取消
          </Button>
          <Button variant="primary" icon={<FolderInput className="size-4" />} loading={organize.isPending} onClick={() => organize.mutate()}>
            整理
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

/** 和后端 organizeCollection 同一个规则：去掉文件名里不能用的字符，最长 70 个字 */
const organizeFolderName = (title: string | null) =>
  (title ?? '组图').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[.$ ]+/, '').slice(0, 70) || '组图';

/** 组图的细线表：张数、来历、作品、最近加入；值为空的行不显示 */
function GroupFacts({ data }: { data: GetCollectionResponse }) {
  const c = data.collection;
  const rows: [string, ReactNode][] = [
    ['张数', `${formatCount(c.pageCount)} 张 · ${data.pageOrder === 'name' ? '按文件名排序' : '按文件修改时间排序'}`],
    ['来历', c.membership === 'post' ? '同一投稿的多张，自动收在一起；改动成员后就算手动收集' : '手动收集'],
    [
      '作品',
      data.works.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          {data.works.map(({ work }) => (
            <Link key={work.id} to={`/works/${work.id}`}>
              <Chip size="sm">{work.name}</Chip>
            </Link>
          ))}
        </span>
      ),
    ],
    ['最近加入', c.lastAddedAt && formatRelative(c.lastAddedAt)],
  ];
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] content-start gap-x-6 gap-y-2.5 text-[13px]">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-subtle">{k}</dt>
            <dd className="min-w-0">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** 奥付：社团、作者、原作、展会、汉化、页数、文件夹、判定、状态、系列；值为空的行不显示 */
function Colophon({ data, onReview }: { data: GetCollectionResponse; onReview: (v: boolean) => void }) {
  const c = data.collection;
  const rows: [string, ReactNode][] = [
    ['社团', c.circle],
    ['作者', c.artist],
    [
      '原作',
      (c.parody || data.works.length > 0) && (
        <span className="flex flex-wrap items-center gap-1.5">
          {c.parody}
          {data.works.map(({ work }) => (
            <Link key={work.id} to={`/works/${work.id}`}>
              <Chip size="sm">{work.name}</Chip>
            </Link>
          ))}
        </span>
      ),
    ],
    ['展会', c.event],
    ['汉化', c.translator],
    ['页数', `${formatCount(c.pageCount)} 页 · ${data.pageOrder === 'name' ? '按文件名排序' : '按文件修改时间排序'}`],
    ['文件夹', data.folderPath ? <span className="font-mono text-[12px] break-all">{data.folderPath}</span> : '按图片成员组织'],
    ['判定', [data.evidence, c.origin === 'manual' ? '手动' : null].filter(Boolean).join(' · ')],
    [
      '状态',
      c.pending ? (
        <span className="flex items-center gap-2">
          待整理
          <Button size="sm" variant="ghost" icon={<Check className="size-3.5" />} onClick={() => onReview(true)}>
            标为已整理
          </Button>
        </span>
      ) : data.reviewed ? (
        <span className="flex items-center gap-2">
          已整理
          <button type="button" className="text-xs text-fg-subtle hover:text-fg hover:underline" onClick={() => onReview(false)}>
            撤回
          </button>
        </span>
      ) : null,
    ],
    [
      '系列',
      data.series.length > 1 && (
        <span className="flex flex-wrap gap-1.5">
          {data.series.map((s) => (
            <Link key={s.id} to={`/collections/${s.id}`}>
              <Chip size="sm" selected={s.id === c.id}>
                {s.volumeNo !== null ? `第 ${s.volumeNo} ${unitWord(data.series)}` : displayTitle(s)}
              </Chip>
            </Link>
          ))}
        </span>
      ),
    ],
  ];
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] content-start gap-x-6 gap-y-2.5 text-[13px]">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-subtle">{k}</dt>
            <dd className="min-w-0">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/**
 * 目次：按页序的网格。本子、画集左下角写页码，点开进阅读器；组图不写页码，点开是看图器。
 * 画集可以只看没认出的页。从图库的收拢格点进来时（带 collectionMembers）先只显示命中筛选的几张。
 */
function TableOfContents({ data }: { data: GetCollectionResponse }) {
  const c = data.collection;
  const group = c.kind === 'group';
  const navigate = useNavigate();
  const location = useLocation();
  const matched = (location.state as { collectionMembers?: string[] } | null)?.collectionMembers;
  const [showAll, setShowAll] = useState(false);
  const narrowed = !!matched && matched.length < c.pageCount && !showAll;
  // 从未识别「成册待整理」点进来的画集带 ?filter=unrecognized：目次默认只看没认出的页（T38f）
  const [onlyUnknown, setOnlyUnknown] = useState(() => new URLSearchParams(window.location.search).get('filter') === 'unrecognized');
  const list = useImagesInfinite({
    collectionId: c.id,
    ...(narrowed ? { imageIds: matched } : {}),
    sort: 'page',
    order: 'asc',
    ...(onlyUnknown ? { status: 'unrecognized' as const } : {}),
  });
  const images = useMemo<ImageItem[]>(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const pageNo = useMemo(() => new Map(data.pages.map((p) => [p.imageId, p.pageNo])), [data.pages]);
  const tagged = useMemo(() => new Map(data.pages.map((p) => [p.imageId, p.tagged])), [data.pages]);
  const { fetchNextPage } = list;
  const loadMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);
  const scope = `collection:${c.id}`;
  const [artistOpen, setArtistOpen] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const selection = useScopedSelection(scope, images, artistOpen || splitting);
  const assign = useMutate((v: { ids: ID[]; characterId: ID }) => api.bulkImages({ ids: v.ids, action: { type: 'assign', characterId: v.characterId } }), {
    onSuccess: selection.clear,
  });
  const rating = useMutate((v: { ids: ID[]; value: Rating }) => api.bulkImages({ ids: v.ids, action: { type: 'rating', value: v.value } }), {
    onSuccess: selection.clear,
  });
  const cover = useMutate((imageId: ID) => api.updateCollection(c.id, { coverImageId: imageId }), { onSuccess: selection.clear });
  const [pickerOpen, setPickerOpen] = useState(false);
  const remove = useMutate((ids: ID[]) => api.updateCollection(c.id, { removeImageIds: ids }), { onSuccess: selection.clear });
  const favorite = useMutate((v: { ids: ID[]; value: boolean }) => api.bulkImages({ ids: v.ids, action: { type: 'favorite', value: v.value } }), {
    onSuccess: selection.clear,
  });
  const trash = useMutate((ids: ID[]) => api.bulkImages({ ids, action: { type: 'trash' } }), { onSuccess: selection.clear });
  const starred = useMemo(() => new Map(images.map((i) => [i.id, i.favorite])), [images]);
  const allFavorite = selection.ids.length > 0 && selection.ids.every((id) => starred.get(id));
  const word = group ? '张' : '页';

  const actions: SelectionAction[] = [
    ...(selection.count === 1
      ? [{ key: 'cover', label: '设为封面', icon: <ImageUp />, loading: cover.isPending, onClick: () => cover.mutate(selection.ids[0]!) }]
      : []),
    { key: 'assign', label: '归到角色…', icon: <UserRoundPlus />, onClick: () => setPickerOpen(true) },
    { key: 'artist', label: '画师…', icon: <Palette />, onClick: () => setArtistOpen(true) },
    {
      key: 'favorite',
      label: allFavorite ? '取消收藏' : '收藏',
      icon: allFavorite ? <HeartOff /> : <Heart />,
      loading: favorite.isPending,
      onClick: () => favorite.mutate({ ids: selection.ids, value: !allFavorite }),
    },
    ...RATINGS.slice(0, 3).map((r) => ({
      key: `rating-${r}`,
      label: RATING_LABEL[r],
      icon: <ShieldHalf />,
      onClick: () => rating.mutate({ ids: selection.ids, value: r }),
    })),
    ...(group ? [{ key: 'split', label: '另建组图…', icon: <Layers />, onClick: () => setSplitting(true) }] : []),
    { key: 'remove', label: group ? '移出组图' : '移出这本', icon: <CircleMinus />, loading: remove.isPending, onClick: () => remove.mutate(selection.ids) },
    { key: 'trash', label: '移到回收站', icon: <Trash2 />, loading: trash.isPending, onClick: () => trash.mutate(selection.ids) },
  ];

  return (
    <section className="mt-14">
      <SectionTitle
        hint={narrowed ? `刚才筛选到的 ${matched!.length} ${word} · 整组 ${formatCount(c.pageCount)} ${word}` : `${formatCount(list.data?.pages[0]?.total ?? c.pageCount)} ${word}`}
        actions={
          narrowed || (matched && showAll) ? (
            <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? `只看筛选到的 ${matched!.length} ${word}` : '看整组'}
            </Button>
          ) : c.kind === 'artbook' && c.unrecognizedPageCount > 0 ? (
            <>
              <Chip size="sm" selected={!onlyUnknown} onClick={() => setOnlyUnknown(false)}>
                全部
              </Chip>
              <Chip size="sm" selected={onlyUnknown} onClick={() => setOnlyUnknown(true)}>
                未认出 {c.unrecognizedPageCount} 页
              </Chip>
            </>
          ) : undefined
        }
      >
        {group ? '图片' : '目次'}
      </SectionTitle>
      {list.isPending ? (
        <ImageGridSkeleton rows={3} rowHeight={200} />
      ) : images.length === 0 ? (
        <EmptyState
          glyph="空"
          title={group ? '这组图里没有可显示的图' : '这一本没有可显示的页'}
          description={group ? '可以点「添加图片…」收进来。图被排除或进了回收站也会离开这里。' : '页可能被排除了，或者进了回收站。'}
        />
      ) : (
        <ImageGrid
          images={images}
          selectionScope={scope}
          rowHeight={200}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={loadMore}
          onOpen={group ? undefined : (img) => navigate(`/collections/${c.id}/read?p=${pageNo.get(img.id) ?? 1}`)}
          forceBlur={(img) => c.kind === 'doujin' && !tagged.get(img.id)}
          renderOverlay={
            group
              ? undefined
              : (img) => (
                  <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-[4px] bg-sheet/90 px-1.5 text-[11px] text-fg-muted numeral tabular">
                    {pageNo.get(img.id)}
                  </span>
                )
          }
        />
      )}
      <CharacterPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        side="top"
        align="center"
        meta={`${selection.count} ${word}`}
        onPick={(ch) => assign.mutate({ ids: selection.ids, characterId: ch.id })}
      >
        <span className="pointer-events-none fixed bottom-24 left-1/2" />
      </CharacterPicker>
      <ArtistBulkPicker open={artistOpen} onOpenChange={setArtistOpen} ids={selection.ids} onDone={selection.clear} />
      <AddToGroupDialog open={splitting} onOpenChange={setSplitting} ids={selection.ids} excludeId={c.id} onDone={selection.clear} />
      <SelectionBar count={selection.count} actions={actions} onClear={selection.clear} />
    </section>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  current,
  onSave,
  placeholder = '书名',
  allowAuto = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: string | null;
  onSave: (title: string | null) => void;
  placeholder?: string;
  /** 有「恢复自动名称」：按文件夹成册的才有自动名 */
  allowAuto?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="改名" description="只改显示的名字，不会改磁盘上的文件夹。">
      {/* 输入框放在弹窗内容里：每次打开都从当前标题开始，取消掉的草稿不留 */}
      <RenameForm current={current} onSave={onSave} onDone={() => onOpenChange(false)} placeholder={placeholder} allowAuto={allowAuto} />
    </Dialog>
  );
}

function RenameForm({
  current,
  onSave,
  onDone,
  placeholder,
  allowAuto,
}: {
  current: string | null;
  onSave: (title: string | null) => void;
  onDone: () => void;
  placeholder: string;
  allowAuto: boolean;
}) {
  const [v, setV] = useState(current ?? '');
  // 包成表单：回车就保存，和别的弹窗一样（输入法选字时浏览器不会提交）
  const save = () => {
    if (!v.trim()) return;
    onSave(v.trim());
    onDone();
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} autoFocus />
      <DialogFooter>
        {allowAuto ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onSave(null);
              onDone();
            }}
          >
            恢复自动名称
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={onDone}>
            取消
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!v.trim()}>
          保存
        </Button>
      </DialogFooter>
    </form>
  );
}

function SeriesDialog({
  open,
  onOpenChange,
  seriesKey,
  volumeNo,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  seriesKey: string | null;
  volumeNo: number | null;
  onSave: (seriesKey: string | null, volumeNo: number | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="归入系列" description="系列名相同的几本会在书架上叠成一张卡。">
      {/* 同上：每次打开都取这一本当前的系列和卷号，不沿用上一本的 */}
      <SeriesForm seriesKey={seriesKey} volumeNo={volumeNo} onSave={onSave} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

function SeriesForm({
  seriesKey,
  volumeNo,
  onSave,
  onDone,
}: {
  seriesKey: string | null;
  volumeNo: number | null;
  onSave: (seriesKey: string | null, volumeNo: number | null) => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState(seriesKey ?? '');
  const [no, setNo] = useState(volumeNo === null ? '' : String(volumeNo));
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
        <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="系列名" />
        <Input value={no} onChange={(e) => setNo(e.target.value.replace(/[^\d.]/g, ''))} placeholder="第几话 / 第几册" inputMode="decimal" />
      </div>
      <DialogFooter>
        <Button
          variant="ghost"
          icon={<CalendarClock className="size-3.5" />}
          onClick={() => {
            onSave(null, null);
            onDone();
          }}
        >
          恢复自动
        </Button>
        <Button
          variant="primary"
          disabled={!key.trim()}
          onClick={() => {
            onSave(key.trim(), no ? Number(no) : null);
            onDone();
          }}
        >
          保存
        </Button>
      </DialogFooter>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="px-8 pt-8">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-8 w-64" />
      <div className="mt-8 grid grid-cols-[240px_minmax(0,1fr)] gap-10">
        <Skeleton className="aspect-[5/7] w-[240px] rounded-[var(--radius-book)]" />
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-2/3" />
          ))}
        </div>
      </div>
    </div>
  );
}
