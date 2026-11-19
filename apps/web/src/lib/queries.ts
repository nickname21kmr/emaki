/**
 * 所有数据读取 / 修改的 React hook。页面只用这里的 hook。
 *
 * 缓存失效（附录 #36）：后端每次提交推一条 changed 事件（SSE），带着变了哪些事实，lib/events.ts 只让相关的 query 失效。
 * 写操作成功后不再自己全部重新获取：等响应头里那条事件的刷新做完（settleRefresh），SSE 断着时才自己按变化类型刷新。
 * 撤销栈里怎么记（可撤销 / 撤销屏障 / 不占位置）由命令注册表决定，在响应头里（metaOf）。
 */
import { showResultToast, undoViaToast } from '@/components/ui/Toast';
import type {
  AccessStatus,
  UndoTokenStatus,
  Character,
  CustomTheme,
  GetCharacterResponse,
  ID,
  Job,
  JobKind,
  StartJobBody,
  ListCharactersQuery,
  CollectionCountsQuery,
  ListCollectionsQuery,
  UnrecognizedAnnexKind,
  UnrecognizedArea,
  UnrecognizedArtKind,
  UnrecognizedBucket,
  UnrecognizedTheme,
  ListImagesQuery,
  ListWorksQuery,
  MutationResult,
  TopCharactersQuery,
  Work,
} from '@emaki/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiRequestError, metaOf, withMeta } from './api';
import { settleRefresh, useLiveJobs } from './events';
import { modKeyLabel } from './hotkeys';
import { uuid } from './random';
import { usePrefs, useUndoReveal, useUndoStore, type CollapseMode, type UndoEntry, type UndoFocus } from './stores';
import { confirmText, madeHere, needsConfirm } from './undoPlace';
import { useCollapseMode } from './urlPrefs';

export const qk = {
  stats: ['stats'] as const,
  summary: ['summary'] as const,
  contentKinds: ['content-kinds'] as const,
  collections: (q: ListCollectionsQuery = {}) => ['collections', q] as const,
  /** 在 'collections' 下面：合集变了和列表一起刷新 */
  collectionCounts: (q: CollectionCountsQuery = {}) => ['collections', 'counts', q] as const,
  artists: ['artists'] as const,
  collection: (id: ID) => ['collection', id] as const,
  works: (q: ListWorksQuery = {}) => ['works', q] as const,
  work: (id: ID) => ['work', id] as const,
  characters: (q: ListCharactersQuery) => ['characters', q] as const,
  topCharacters: (q: TopCharactersQuery) => ['characters', 'top', q] as const,
  character: (id: ID) => ['character', id] as const,
  coverCandidates: (id: ID, limit: number) => ['character', id, 'cover-candidates', limit] as const,
  images: (q: ListImagesQuery) => ['images', q] as const,
  image: (id: ID) => ['image', id] as const,
  unrecognized: ['unrecognized'] as const,
  duplicates: (resolved: boolean) => ['duplicates', resolved] as const,
  exclusions: ['exclusions'] as const,
  search: (q: string) => ['search', q] as const,
  tags: (q: string) => ['tags', q] as const,
  tagPhrase: (q: string) => ['tag-phrase', q] as const,
  settings: ['settings'] as const,
  taggerModels: ['tagger-models'] as const,
  jobs: ['jobs'] as const,
  health: ['health'] as const,
  /** 设置 →「手机访问」和批准提示（GET /api/access）；null = 这个入口上看不了（局域网入口的设备没有 devices 权限） */
  access: ['access'] as const,
  /** 谁在调用（GET /api/me）：网页按它隐藏用不了的入口（lib/capabilities.ts） */
  me: ['me'] as const,
};

// ------------------------------------------------------------------ 读取

export const useCustomCharacterMatches = (enabled: boolean) => useQuery({
  queryKey: ['custom-character-matches'], queryFn: api.customCharacterMatches, enabled,
});

export const useStats = () => useQuery({ queryKey: qk.stats, queryFn: api.stats });
/** 汇总接口（P5）：侧栏、首页、命令面板、统计条显示的数都读它，不要自己拿 stats 加减（附录 #28） */
export const useSummary = () => useQuery({ queryKey: qk.summary, queryFn: api.summary });

/** 合集（T38）：书架列表和一本的详情。写操作走 useMutate，成功后全部失效 */
/** 识别出来的画师（合集页的「画师」） */
export const useArtists = (enabled = true) => useQuery({ queryKey: qk.artists, queryFn: api.artists, enabled });

export const useCollections = (q: ListCollectionsQuery = {}, enabled = true) =>
  useQuery({ queryKey: qk.collections(q), queryFn: () => api.collections(q), placeholderData: keepPreviousData, enabled });
/** 合集的数目（每一类、每种成员来源）：合集页的副标题、每类的小字、「另有 N 组同一投稿」，不用为了数目拉全部列表 */
export const useCollectionCounts = (q: CollectionCountsQuery = {}) =>
  useQuery({ queryKey: qk.collectionCounts(q), queryFn: () => api.collectionCounts(q), placeholderData: keepPreviousData });
export const useCollection = (id: ID | undefined) =>
  useQuery({ queryKey: qk.collection(id ?? ''), queryFn: () => api.collection(id!), enabled: !!id });

/** 别册：每一类的张数和预览（T27） */
export const useContentKinds = () => useQuery({ queryKey: qk.contentKinds, queryFn: api.contentKinds });

export const useWorks = (q: ListWorksQuery = {}) => useQuery({ queryKey: qk.works(q), queryFn: () => api.works(q) });

export const useWork = (id: ID | undefined) =>
  useQuery({ queryKey: qk.work(id ?? ''), queryFn: () => api.work(id!), enabled: !!id });

export const useTopCharacters = (q: TopCharactersQuery = {}) =>
  useQuery({ queryKey: qk.topCharacters(q), queryFn: () => api.topCharacters(q), placeholderData: keepPreviousData });

export const useCharacter = (id: ID | undefined) => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.character(id ?? ''),
    queryFn: () => api.character(id!),
    enabled: !!id,
    // 从列表点进来时先用列表缓存里的这个角色顶上，扉页同帧就有图版（SEL-14）；related 等详情到了再补
    placeholderData: () => (id ? characterFromCaches(qc, id) : undefined),
  });
};

/** 「换封面」候选（CB-7）：面板打开时才拉 */
export const useCoverCandidates = (id: ID, limit = 12, enabled = true) =>
  useQuery({ queryKey: qk.coverCandidates(id, limit), queryFn: () => api.coverCandidates(id, { limit }), enabled });

/** 在角色列表 / Top / 搜索的缓存里找这个角色，拼一份临时的详情 */
function characterFromCaches(qc: QueryClient, id: ID): GetCharacterResponse | undefined {
  let found: Character | undefined;
  const visit = (v: unknown) => {
    if (found || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    if (o.id === id && typeof o.name === 'string' && 'imageCount' in o) found = o as unknown as Character;
    else if ('pages' in o) visit(o.pages);
    else if ('items' in o) visit(o.items);
    else if ('character' in o) visit(o.character);
  };
  for (const key of [['characters'], ['search']]) {
    for (const [, data] of qc.getQueriesData({ queryKey: key })) visit(data);
  }
  if (!found) return undefined;
  const works = new Map<ID, Work>();
  for (const [, data] of qc.getQueriesData<Work[]>({ queryKey: ['works'] })) data?.forEach((w) => works.set(w.id, w));
  return { character: found, works: found.workIds.flatMap((w) => works.get(w) ?? []), related: [] };
}

/** 悬停在角色封面上时预取详情（SEL-14） */
export function usePrefetchCharacter() {
  const qc = useQueryClient();
  return (id: ID) => void qc.prefetchQuery({ queryKey: qk.character(id), queryFn: () => api.character(id), staleTime: 30_000 });
}

/** 角色列表（无限滚动） */
export const useCharactersInfinite = (q: Omit<ListCharactersQuery, 'cursor'>) =>
  useInfiniteQuery({
    queryKey: qk.characters(q),
    queryFn: ({ pageParam }) => api.characters({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/** 收拢偏好 → 接口参数 */
export const collapseParam = (mode: CollapseMode): boolean | 'auto' => (mode === 'auto' ? 'auto' : mode === 'on');

/** 图片列表（无限滚动），配合 components/media/ImageGrid 使用 */
export const useImagesInfinite = (q: Omit<ListImagesQuery, 'cursor'>) => {
  // 收拢组图（本机偏好，URL 里写了按 URL）：看一本合集的页时不收拢；auto 交给后端按结果张数决定
  const mode = useCollapseMode();
  const query = { ...q, collapseCollections: q.collapseCollections ?? (q.collectionId ? false : collapseParam(mode)) };
  return useInfiniteQuery({
    queryKey: qk.images(query),
    queryFn: ({ pageParam }) => api.images({ limit: 120, ...query, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
};

/** 只要张数（编辑自定义画面时预览能筛出多少张） */
export const useImageCount = (q: Omit<ListImagesQuery, 'cursor' | 'limit'>, enabled = true) =>
  useQuery({
    queryKey: ['image-count', q] as const,
    queryFn: () => api.images({ ...q, limit: 1 }).then((p) => p.total),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useImage = (id: ID | null | undefined) =>
  useQuery({ queryKey: qk.image(id ?? ''), queryFn: () => api.image(id!), enabled: !!id });

/** 未识别列表的参数（T34b）：大类、分段、主题、别册类型、插画 / 漫画 */
export interface UnrecognizedParams {
  collapseCollections?: boolean | 'auto';
  area: UnrecognizedArea;
  bucket?: UnrecognizedBucket;
  theme?: UnrecognizedTheme;
  kind?: UnrecognizedAnnexKind;
  artKind?: UnrecognizedArtKind;
}

export const useUnrecognizedInfinite = (p: UnrecognizedParams = { area: 'art' }, limit = 60) =>
  useInfiniteQuery({
    // 前缀仍是 'unrecognized'：全局失效照常覆盖
    queryKey: [...qk.unrecognized, p.area, p.bucket ?? 'all', p.theme ?? 'all', p.kind ?? 'all', p.artKind ?? 'all', p.collapseCollections ?? false],
    queryFn: ({ pageParam }) => api.unrecognized({ ...p, limit, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** 不传 artKind 是整体的汇总（侧栏、副标题、识别按钮用这份）；传了只算插画或漫画 */
export const useUnrecognizedSummary = (artKind?: UnrecognizedArtKind) =>
  useQuery({
    queryKey: artKind ? [...qk.unrecognized, 'summary', artKind] : [...qk.unrecognized, 'summary'],
    queryFn: () => api.unrecognizedSummary(artKind ? { artKind } : {}),
    staleTime: 5_000,
  });

export const useDuplicates = (resolved = false, enabled = true) =>
  useQuery({ queryKey: qk.duplicates(resolved), queryFn: () => api.duplicates({ resolved }), enabled });

export const useExclusions = () => useQuery({ queryKey: qk.exclusions, queryFn: api.exclusions });

export const useSearch = (q: string, forAssignment = false) =>
  useQuery({
    queryKey: forAssignment ? [...qk.search(q), 'assignment'] : qk.search(q),
    queryFn: () => api.search(q, 20, forAssignment),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: api.settings });

/** 一般标签联想（自定义画面的对话框）；空查询也发，给出最常见的 */
export const useTagSuggestions = (q: string, enabled = true) =>
  useQuery({
    queryKey: qk.tags(q.trim()),
    queryFn: () => api.tags(q.trim()),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

/** 一句话拆成标签（图库搜索框的下拉）；空串不发 */
export const useTagPhrase = (q: string) =>
  useQuery({
    queryKey: qk.tagPhrase(q.trim()),
    queryFn: () => api.tagPhrase(q.trim()),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

const NO_THEMES: CustomTheme[] = [];
/** 用户自己加的「画面」筛选（设置里的 browse.customThemes）；旧后端没有这一段时为空 */
export function useCustomThemes(): CustomTheme[] {
  const { data } = useSettings();
  return data?.browse?.customThemes ?? NO_THEMES;
}

/** 识别模型列表（设置页下拉框） */
export const useTaggerModels = () => useQuery({ queryKey: qk.taggerModels, queryFn: api.taggerModels });

export const useJobs = () => useQuery({ queryKey: qk.jobs, queryFn: api.jobs });

/**
 * 手机访问的状态：开关、端口、地址、等批准的请求、已批准的设备。变化靠 SSE 的 access 事件（lib/events.ts）。
 * 只有本机入口能看：局域网入口上的设备调用是 403，这时返回 null（不报错、不重试，批准提示也就不出现）
 */
export const useAccessStatus = (enabled = true) =>
  useQuery({
    queryKey: qk.access,
    queryFn: async (): Promise<AccessStatus | null> => {
      try {
        return await api.accessStatus();
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 403) return null;
        throw err;
      }
    },
    enabled,
  });

/**
 * 谁在调用（GET /api/me）：本机入口 local、全部范围；局域网入口是这台设备和它真正生效的范围。能力的计算在 lib/capabilities.ts。
 * 权限变了由服务端推 me 事件（lib/events.ts）、请求回 403 forbidden 时重新取（watchForbidden），所以不过期；
 * 设备上窗口重新获得焦点时也取一次（手机从后台切回来）。连不上时少重试几次：取不到按本机入口处理，页面不一直等它
 */
export const useMe = () =>
  useQuery({
    queryKey: qk.me,
    queryFn: api.me,
    staleTime: Infinity,
    refetchOnWindowFocus: (q) => q.state.data?.kind === 'device',
    retry: meRetry,
    retryDelay: 500,
  });

/** /api/me 只在连不上时重试两次（401 是没配对，交给配对页；别的错误重试也没用） */
export const meRetry = (count: number, err: unknown) => err instanceof ApiRequestError && err.code === 'network' && count < 2;

/** 后端版本、数据源（demo / sqlite）、数据目录；进程内不会变 */
export const useHealth = () => useQuery({ queryKey: qk.health, queryFn: api.health, staleTime: Infinity });

/** 移到回收站最近 5 次可以撤销，更早的已经放进系统回收站，要去那里还原 */
export const TRASH_HINT = '移到回收站（最近 5 次可撤销）';

// ------------------------------------------------------------------ 修改

export function invalidateAll(client: QueryClient) {
  return client.invalidateQueries();
}

const PLAIN_NOTE = '这一步不能撤销，需要的话请手动改回去（任务可以在设置里取消）。再按一次撤销会撤更早的操作。';
const TRASH_NOTE = '文件已经放进系统回收站，要找回请去系统回收站还原。再按一次撤销会撤更早的操作。';
const barrierId = () => `barrier:${uuid()}`;

/**
 * 一次写操作在撤销栈里记什么：有 token 记 token；回收站那种撤销不了的占位；不可撤销的命令（改设置、启动任务……）也占一格（撤销屏障），
 * Ctrl+Z 不会悄悄越过它去撤更早的。是不是屏障由命令注册表决定（响应头 x-emaki-undo，metaOf），前端不再自己猜；
 * 没有说明的（不是命令的接口、旧后端）照旧：没有 token 就按 barrier（占位的说法）占一格
 */
export function entryOf(result: MutationResult, barrier?: string | null): UndoEntry | null {
  if (result.undoToken) return { token: result.undoToken, label: result.message };
  if (result.irreversible) return { token: barrierId(), label: result.message, barrier: true };
  const meta = metaOf(result);
  if (meta) return meta.undo === 'barrier' ? { token: barrierId(), label: barrier || result.message, barrier: true, note: PLAIN_NOTE } : null;
  if (barrier) return { token: barrierId(), label: barrier, barrier: true, note: PLAIN_NOTE };
  return null;
}

// 还在进行的写操作的占位：落定后给出 token（没做成是 false）
const pendingWaiters = new Map<string, { promise: Promise<string | null | false>; resolve: (t: string | null | false) => void }>();
// Ctrl+Z 已经在等的占位：落定时不再弹结果 toast，马上就撤掉了
const undoQueued = new Set<string>();

/** 写操作一开始就在撤销栈顶占个位置，免得请求还没回来时 Ctrl+Z 撤到上一步 */
export function beginPending(label: string, focus?: UndoFocus): string {
  const id = `pending:${uuid()}`;
  let resolve!: (t: string | null | false) => void;
  const promise = new Promise<string | null | false>((r) => (resolve = r));
  pendingWaiters.set(id, { promise, resolve });
  useUndoStore.getState().push({ token: id, label, pending: true, ...(focus && { focus }) });
  return id;
}

/** 占位落定：原地换成真正的那条（null 拿掉）；failed 表示操作没做成 */
export function settlePending(id: string, entry: UndoEntry | null, failed = false) {
  useUndoStore.getState().replace(id, entry);
  // 正在问「要不要撤销」的就是这条：跟着换成真正的 token，没做成就收起提示
  if (asking?.token === id) {
    if (entry) asking.token = entry.token;
    else dismissAsk();
  }
  pendingWaiters.get(id)?.resolve(failed ? false : (entry?.token ?? null));
  pendingWaiters.delete(id);
}

/**
 * 显示结果 toast；带 undoToken 的附带「撤销」按钮，并记入顶栏撤销栈。
 * pending：开始时占的位置；barrier：没有撤销时占位用的说法；entry：自己决定记什么（例如多个 token 合成一条）
 */
export function announce(
  result: MutationResult,
  client: QueryClient,
  opts: { pending?: string; silent?: boolean; barrier?: string | null; entry?: UndoEntry | null } = {},
) {
  // 墨色胶囊 + 朱色引信（SEL-11）；可撤销的记入顶栏撤销栈
  const entry = opts.entry !== undefined ? opts.entry : entryOf(result, opts.barrier);
  if (opts.pending) settlePending(opts.pending, entry);
  else if (entry) useUndoStore.getState().push(entry);
  markCommitted(result);
  const queued = !!opts.pending && undoQueued.delete(opts.pending);
  if (!opts.silent && !queued) showResultToast(result.message, result.undoToken, client);
}

/** 顶栏撤销按钮 / 命令面板里怎么说栈顶这一条 */
export const undoTitle = (e: UndoEntry) =>
  e.barrier ? `上一步撤销不了：${e.label}` : e.pending ? `撤销：${e.label}（还在进行）` : `撤销：${e.label}`;

/** 这次移到回收站把更早的几次挤出了可撤销的范围：撤销栈里那几条原地变成撤销不了的占位 */
export function markCommitted(result: MutationResult) {
  if (result.expiredUndoTokens?.length) useUndoStore.getState().markBarrier(result.expiredUndoTokens);
}

/**
 * 返回撤销的结果：'ok' 成功（交给 toast 处理的也算）；'gone' 后端回了话但撤销不了（token 没了，再试也没用）；
 * 'failed' 连不上，可以再试。只管弹提示的调用方忽略返回值即可。注意 'gone' 也是真值，别拿来当成功判断
 */
export function undo(token: string, client: QueryClient): Promise<UndoOutcome> {
  // 连按两次 Ctrl+Z 拿到的是同一个 promise，不会撤两遍
  const running = undoing.get(token);
  if (running) return running;
  const p = runUndo(token, client).finally(() => undoing.delete(token));
  undoing.set(token, p);
  return p;
}

type UndoOutcome = 'ok' | 'gone' | 'failed';
const undoing = new Map<string, Promise<UndoOutcome>>();

async function runUndo(token: string, client: QueryClient): Promise<UndoOutcome> {
  const entry = useUndoStore.getState().entries.find((e) => e.token === token);
  // 还没做完的那一步：等它落定再撤
  if (entry?.pending) {
    const waiter = pendingWaiters.get(token);
    if (!waiter) {
      useUndoStore.getState().remove(token);
      return 'gone';
    }
    undoQueued.add(token);
    const id = toast.loading('正在撤销…', { description: `等「${entry.label}」做完再撤` });
    const final = await waiter.promise;
    undoQueued.delete(token);
    toast.dismiss(id);
    if (final === false) {
      toast(`「${entry.label}」没有做成，不用撤销`);
      return 'gone';
    }
    if (!final) return 'gone';
    // 落定和这里之间只隔微任务，按键插不进来；接着登记，第二次 Ctrl+Z 拿到的还是这一次
    return undo(final, client);
  }
  // 撤销不了的那一步：说一声再拿掉，下一次 Ctrl+Z 才轮到更早的
  if (entry?.barrier) {
    useUndoStore.getState().remove(token);
    toast(`上一步撤销不了：${entry.label}`, { description: entry.note ?? TRASH_NOTE });
    return 'gone';
  }
  // 这条的 toast 还在：交给它撤销，胶囊原地变成「已撤销」
  if (undoViaToast(token)) return 'ok';
  try {
    let message: string;
    let last: MutationResult | undefined;
    if (entry?.tokens) {
      for (const t of [...entry.tokens].reverse()) last = await api.undo(t);
      message = `已撤销：${entry.label}`;
    } else {
      last = await api.undo(token);
      message = last.message;
    }
    useUndoStore.getState().remove(token);
    // 别的页面做的：给个「去看看」；本页做的：刷新后把撤回来的东西指给用户看
    const where = afterUndone(entry);
    toast(message, where === 'elsewhere' && entry ? { action: { label: '去看看', onClick: () => goToUndone(entry) } } : undefined);
    // 撤销的重放也推 changed 事件：等它刷新完（几个令牌一起撤的，最后一个的事件最新）
    await settleRefresh(client, metaOf(last));
    return 'ok';
  } catch (err) {
    forgetFailedUndo(token, err);
    toast.error(errorMessage(err));
    if (entry?.tokens) await invalidateAll(client);
    return err instanceof ApiRequestError && err.code !== 'network' ? 'gone' : 'failed';
  }
}

// ------------------------------------------------------------------ Ctrl+Z / 顶栏撤销：先看在哪、多久以前

/** 正在问「要不要撤销」的那条和它的提示 toast */
let asking: { token: string; toastId: string | number } | null = null;

function dismissAsk() {
  if (!asking) return;
  toast.dismiss(asking.toastId);
  asking = null;
}

const herePath = () => (typeof window !== 'undefined' ? window.location.pathname : '/');

/**
 * Ctrl+Z、顶栏撤销、命令面板撤销都走这里：撤栈顶那一步。
 * 别的页面做的、或者超过 2 分钟的，先弹一条带「撤销 / 取消」的提示；提示还在时再按一次就是确认。
 * 返回 'asked' 弹了提示，'undone' 开始撤销，'none' 栈是空的
 */
export function requestUndo(client: QueryClient, path = herePath(), now = Date.now()): 'none' | 'asked' | 'undone' {
  const top = useUndoStore.getState().entries[0];
  if (asking) {
    const confirmed = !!top && asking.token === top.token;
    dismissAsk();
    if (confirmed) {
      void undo(top.token, client);
      return 'undone';
    }
  }
  if (!top) return 'none';
  if (!needsConfirm(top, path, now)) {
    void undo(top.token, client);
    return 'undone';
  }
  const ask: { token: string; toastId: string | number } = { token: top.token, toastId: '' };
  const clear = () => {
    if (asking === ask) asking = null;
  };
  ask.toastId = toast(confirmText(top, path, now), {
    description: `再按一次 ${modKeyLabel} Z 也是确认`,
    duration: 8000,
    action: {
      label: '撤销',
      onClick: () => {
        clear();
        // 问的时候又做了新的操作：不越过它去撤更早的
        if (useUndoStore.getState().entries[0]?.token !== ask.token) return void toast('又有了新的操作，这次没有撤销');
        void undo(ask.token, client);
      },
    },
    cancel: { label: '取消', onClick: clear },
    onDismiss: clear,
    onAutoClose: clear,
  });
  asking = ask;
  return 'asked';
}

/** 测试用：现在是不是在问 */
export const isAskingUndo = () => asking !== null;

let navigateTo: ((href: string) => void) | null = null;
/** AppShell 把路由的 navigate 交过来，「去看看」用 */
export function setUndoNavigate(fn: ((href: string) => void) | null) {
  navigateTo = fn;
}

/**
 * 撤销成功之后：本页做的，把要指给人看的东西交给页面（useUndoReveal）；别的页面做的返回 'elsewhere'，调用方给个「去看看」
 */
export function afterUndone(e: UndoEntry | undefined, path = herePath()): 'here' | 'elsewhere' | null {
  if (!e) return null;
  if (madeHere(e, path)) {
    if (e.focus) useUndoReveal.setState({ reveal: { path, focus: e.focus, at: Date.now() } });
    return 'here';
  }
  return 'elsewhere';
}

/** 「去看看」：回到做这一步的页面，到了以后照样指给用户看 */
export function goToUndone(e: UndoEntry) {
  if (!e.path) return;
  if (e.focus) useUndoReveal.setState({ reveal: { path: e.path, focus: e.focus, at: Date.now() } });
  const href = e.href ?? e.path;
  if (navigateTo) navigateTo(href);
  else window.location.assign(href);
}

// 同一轮渲染里各条勘误要问的 token 攒成一次请求
let undoBatch: Map<string, ((s: UndoTokenStatus) => void)[]> | null = null;
function flushUndoBatch() {
  const batch = undoBatch;
  undoBatch = null;
  if (!batch) return;
  // 问不到（连不上、旧后端）按 live 算，按钮照常可点
  const settle = (status: Record<string, UndoTokenStatus>) => {
    for (const [t, waiters] of batch) for (const w of waiters) w(status[t] ?? 'live');
  };
  api.undoStatus([...batch.keys()]).then((r) => settle(r.status), () => settle({}));
}
function fetchUndoStatus(token: string) {
  return new Promise<UndoTokenStatus>((resolve) => {
    if (!undoBatch) {
      undoBatch = new Map();
      setTimeout(flushUndoBatch, 0);
    }
    undoBatch.set(token, [...(undoBatch.get(token) ?? []), resolve]);
  });
}

/** 撤销 token 在后端还在不在（重启过、被挤出撤销栈、在别处撤销过）。library-changed 和重连都会让它重拉 */
export function useUndoStatus(token: string, enabled: boolean) {
  return useQuery({ queryKey: ['undo-status', token], queryFn: () => fetchUndoStatus(token), enabled: enabled && !!token, retry: false });
}

/**
 * 撤销失败：只要后端回了话（不是网络错误），这个 token 在后端就已经没了（过期、重启过，或者 revert 前已经删掉），
 * 从撤销栈里拿掉，免得 Ctrl+Z 一直卡在它上面、更早的轮不到。连不上时留着，下次还能再试
 */
export function forgetFailedUndo(token: string, err: unknown) {
  if (err instanceof ApiRequestError && err.code !== 'network') useUndoStore.getState().remove(token);
}

/**
 * 启动后台任务。startJob 返回 Job 而不是 MutationResult，这里统一包一层：toast + 刷新，
 * 并先把任务写进实时任务表（SSE 可能比响应先到；已有记录时别用旧快照覆盖）。
 *   const start = useStartJob((job) => `已开始${job.kind}`);  start.mutate('scan');
 */
export function useStartJob(message: (job: Job) => string) {
  return useMutate((input: JobKind | StartJobBody) =>
    (typeof input === 'string' ? api.startJob(input) : api.startJob(input.kind, input)).then((job): MutationResult => {
      const live = useLiveJobs.getState();
      if (!live.jobs[job.id]) live.upsert(job);
      // 启动任务是不可撤销的命令：撤销屏障来自注册表（响应头），带过来
      return withMeta({ ok: true, message: message(job), undoToken: null }, job);
    }),
  );
}

/** 从写操作的参数里猜撤销后要指给人看的图：{ ids: [...] } 或 { id } */
export function focusOf(vars: unknown): UndoFocus | undefined {
  if (!vars || typeof vars !== 'object') return undefined;
  const v = vars as { ids?: unknown; id?: unknown };
  if (Array.isArray(v.ids) && v.ids.length && v.ids.every((x) => typeof x === 'string')) return { images: v.ids.slice(0, 200) as ID[] };
  if (typeof v.id === 'string') return { images: [v.id] };
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * 通用修改 hook：成功 → toast（带撤销）+ 刷新相关的查询（等 SSE 那条事件的刷新，只刷新一遍）；失败 → 错误 toast。
 *
 *   const assign = useMutate((ids: ID[]) => api.bulkImages({ ids, action: { type: 'assign', characterId } }));
 *   assign.mutate(selectedIds);
 */
export function useMutate<TVars, TResult extends MutationResult = MutationResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: {
    silent?: boolean;
    onSuccess?: (result: TResult, vars: TVars) => void;
    /** 自己显示错误（例如表单下方的小字）；不传则弹错误 toast */
    onError?: (message: string, err: unknown) => void;
    /** 撤销栈里的说法：进行中显示它；没有撤销的结果也用它占位（不传就用结果那句话） */
    label?: string | ((vars: TVars) => string);
    /** false：不碰撤销栈，留给纯外观偏好、只读的动作 */
    undo?: false;
    /** 自己决定撤销栈里记什么（例如多个 token 合成一条） */
    entry?: (result: TResult, vars: TVars) => UndoEntry | null;
    /** 撤销后要指给用户看什么；不传时从参数里的 ids / id 猜是哪些图 */
    focus?: (vars: TVars) => UndoFocus | undefined;
  } = {},
) {
  const client = useQueryClient();
  const labelOf = (vars: TVars) => (typeof opts.label === 'function' ? opts.label(vars) : opts.label);
  return useMutation({
    mutationFn: fn,
    // 一点下去就占住撤销栈顶：乐观更新的页面不等接口返回就往下走，这时按 Ctrl+Z 也该撤这一步
    onMutate: (vars): string | undefined =>
      opts.undo === false ? undefined : beginPending(labelOf(vars) ?? '刚才的操作', opts.focus ? opts.focus(vars) : focusOf(vars)),
    onSuccess: async (result, vars, pending) => {
      // silent 的自己弹提示，但 token / 占位照样进撤销栈
      announce(result, client, {
        pending,
        silent: opts.silent,
        barrier: opts.undo === false ? null : (labelOf(vars) ?? result.message),
        ...(opts.entry && { entry: opts.entry(result, vars) }),
      });
      opts.onSuccess?.(result, vars);
      await settleRefresh(client, metaOf(result));
    },
    onError: (err, _vars, pending) => {
      if (pending) settlePending(pending, null, true);
      if (opts.onError) opts.onError(errorMessage(err), err);
      else toast.error(errorMessage(err));
    },
  });
}
