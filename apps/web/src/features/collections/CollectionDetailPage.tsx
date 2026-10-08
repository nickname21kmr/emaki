import type { GetCollectionResponse, ID, ImageItem, Rating } from '@emaki/shared';
import {
  ArrowDownAZ,
  BookOpenText,
  CalendarClock,
  Check,
  CircleOff,
  Ellipsis,
  FolderOpen,
  ImageUp,
  Layers,
  Palette,
  PencilLine,
  RotateCcw,
  ShieldHalf,
  UserRoundPlus,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageBody, PageHeader } from '@/components/layout/PageHeader';
import { AvatarTile } from '@/components/media/AvatarTile';
import { BookPlate } from '@/components/media/BookPlate';
import { ImageGrid, ImageGridSkeleton } from '@/components/media/ImageGrid';
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
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  SectionTitle,
  Skeleton,
} from '@/components/ui';
import { api } from '@/lib/api';
import { byline, COLLECTION_META, displayTitle, readProgress, unitWord } from '@/lib/collections';
import { formatCount, RATING_LABEL } from '@/lib/format';
import { useCollection, useImagesInfinite, useMutate } from '@/lib/queries';
import { ArtistBulkPicker } from '@/features/gallery/ArtistPicker';
import { CharacterPicker } from '@/features/gallery/CharacterPicker';
import { WorkPicker } from '@/features/characters/detail/WorkPicker';
import { SelectionBar, type SelectionAction } from '@/features/characters/detail/SelectionBar';
import { useScopedSelection } from '@/features/characters/detail/useScopedSelection';

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
  return <Detail data={q.data} />;
}

function Detail({ data }: { data: GetCollectionResponse }) {
  const c = data.collection;
  const m = COLLECTION_META[c.kind];
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'rename' | 'series' | 'works' | null>(null);
  const update = useMutate((body: Parameters<typeof api.updateCollection>[1]) => api.updateCollection(c.id, body));
  const dismiss = useMutate(() => api.deleteCollection(c.id), { onSuccess: () => navigate('/collections') });
  const progress = readProgress.get(c.id);
  const manualChars = data.cast.filter((x) => x.manual).map((x) => x.character.id);
  const manualWorks = data.works.filter((x) => x.manual).map((x) => x.work.id);

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
              <MenuItem icon={<m.icon />} onSelect={() => update.mutate({ kind: c.kind === 'doujin' ? 'artbook' : 'doujin' })}>
                {c.kind === 'doujin' ? '改成画集' : '改成本子'}
              </MenuItem>
              <MenuItem icon={<RotateCcw />} onSelect={() => update.mutate({ kind: 'auto' })}>
                恢复自动判断类型
              </MenuItem>
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
                不成册
              </MenuItem>
            </Menu>
          </>
        }
      />
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

      <RenameDialog open={dialog === 'rename'} onOpenChange={(o) => !o && setDialog(null)} current={c.title} onSave={(title) => update.mutate({ title })} />
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
    ['文件夹', <span className="font-mono text-[12px] break-all">{data.folderPath}</span>],
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

/** 02 目次：按页序的网格，左下角写页码；画集可以只看没认出的页 */
function TableOfContents({ data }: { data: GetCollectionResponse }) {
  const c = data.collection;
  const navigate = useNavigate();
  // 从未识别「成册待整理」点进来的画集带 ?filter=unrecognized：目次默认只看没认出的页（T38f）
  const [onlyUnknown, setOnlyUnknown] = useState(() => new URLSearchParams(window.location.search).get('filter') === 'unrecognized');
  const list = useImagesInfinite({
    collectionId: c.id,
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
  const selection = useScopedSelection(scope, images, artistOpen);
  const assign = useMutate((v: { ids: ID[]; characterId: ID }) => api.bulkImages({ ids: v.ids, action: { type: 'assign', characterId: v.characterId } }), {
    onSuccess: selection.clear,
  });
  const rating = useMutate((v: { ids: ID[]; value: Rating }) => api.bulkImages({ ids: v.ids, action: { type: 'rating', value: v.value } }), {
    onSuccess: selection.clear,
  });
  const cover = useMutate((imageId: ID) => api.updateCollection(c.id, { coverImageId: imageId }), { onSuccess: selection.clear });
  const [pickerOpen, setPickerOpen] = useState(false);

  const actions: SelectionAction[] = [
    ...(selection.count === 1
      ? [{ key: 'cover', label: '设为封面', icon: <ImageUp />, loading: cover.isPending, onClick: () => cover.mutate(selection.ids[0]!) }]
      : []),
    { key: 'assign', label: '归到角色…', icon: <UserRoundPlus />, onClick: () => setPickerOpen(true) },
    { key: 'artist', label: '画师…', icon: <Palette />, onClick: () => setArtistOpen(true) },
    ...RATINGS.slice(0, 3).map((r) => ({
      key: `rating-${r}`,
      label: RATING_LABEL[r],
      icon: <ShieldHalf />,
      onClick: () => rating.mutate({ ids: selection.ids, value: r }),
    })),
  ];

  return (
    <section className="mt-14">
      <SectionTitle
        hint={`${formatCount(c.pageCount)} 页`}
        actions={
          c.kind === 'artbook' && c.unrecognizedPageCount > 0 ? (
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
        目次
      </SectionTitle>
      {list.isPending ? (
        <ImageGridSkeleton rows={3} rowHeight={200} />
      ) : images.length === 0 ? (
        <EmptyState glyph="空" title="这一本没有可显示的页" description="页可能被排除了，或者进了回收站。" />
      ) : (
        <ImageGrid
          images={images}
          selectionScope={scope}
          rowHeight={200}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={loadMore}
          onOpen={(img) => navigate(`/collections/${c.id}/read?p=${pageNo.get(img.id) ?? 1}`)}
          forceBlur={(img) => c.kind === 'doujin' && !tagged.get(img.id)}
          renderOverlay={(img) => (
            <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-[4px] bg-sheet/90 px-1.5 text-[11px] text-fg-muted numeral tabular">
              {pageNo.get(img.id)}
            </span>
          )}
        />
      )}
      <CharacterPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        side="top"
        align="center"
        meta={`${selection.count} 页`}
        onPick={(ch) => assign.mutate({ ids: selection.ids, characterId: ch.id })}
      >
        <span className="pointer-events-none fixed bottom-24 left-1/2" />
      </CharacterPicker>
      <ArtistBulkPicker open={artistOpen} onOpenChange={setArtistOpen} ids={selection.ids} onDone={selection.clear} />
      <SelectionBar count={selection.count} actions={actions} onClear={selection.clear} />
    </section>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  current,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: string | null;
  onSave: (title: string | null) => void;
}) {
  const [v, setV] = useState(current ?? '');
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="改名" description="只改显示的名字，不会改磁盘上的文件夹。">
      <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="书名" autoFocus />
      <DialogFooter>
        <Button
          variant="ghost"
          onClick={() => {
            onSave(null);
            onOpenChange(false);
          }}
        >
          恢复自动名称
        </Button>
        <Button
          variant="primary"
          disabled={!v.trim()}
          onClick={() => {
            onSave(v.trim());
            onOpenChange(false);
          }}
        >
          保存
        </Button>
      </DialogFooter>
    </Dialog>
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
  const [key, setKey] = useState(seriesKey ?? '');
  const [no, setNo] = useState(volumeNo === null ? '' : String(volumeNo));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="归入系列" description="系列名相同的几本会在书架上叠成一张卡。">
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
            onOpenChange(false);
          }}
        >
          恢复自动
        </Button>
        <Button
          variant="primary"
          disabled={!key.trim()}
          onClick={() => {
            onSave(key.trim(), no ? Number(no) : null);
            onOpenChange(false);
          }}
        >
          保存
        </Button>
      </DialogFooter>
    </Dialog>
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
