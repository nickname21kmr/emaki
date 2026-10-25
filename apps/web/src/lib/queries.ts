/**
 * 所有数据读取 / 修改的 React hook。页面只用这里的 hook。
 *
 * 缓存失效策略很简单：任何修改成功后 invalidate 全部 query（本地应用，数据量小，请求都很快），
 * 另外后端通过 SSE 推 `library-changed` 时也会全部失效（见 lib/events.ts）。
 */
import { showResultToast, undoViaToast } from '@/components/ui/Toast';
import type {
  UndoTokenStatus,
  Character,
  CustomTheme,
  GetCharacterResponse,
  ID,
  Job,
  JobKind,
  StartJobBody,
  ListCharactersQuery,
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
import { api, ApiRequestError } from './api';
import { useLiveJobs } from './events';
import { modKeyLabel } from './hotkeys';
import { useUndoReveal, useUndoStore, type UndoEntry, type UndoFocus } from './stores';
import { confirmText, madeHere, needsConfirm } from './undoPlace';

export const qk = {
  stats: ['stats'] as const,
  contentKinds: ['content-kinds'] as const,
  collections: (q: ListCollectionsQuery = {}) => ['collections', q] as const,
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
  settings: ['settings'] as const,
  taggerModels: ['tagger-models'] as const,
  jobs: ['jobs'] as const,
  health: ['health'] as const,
};

// ------------------------------------------------------------------ 读取

export const useCustomCharacterMatches = (enabled: boolean) => useQuery({
  queryKey: ['custom-character-matches'], queryFn: api.customCharacterMatches, enabled,
});

export const useStats = () => useQuery({ queryKey: qk.stats, queryFn: api.stats });

/** 合集（T38）：书架列表和一本的详情。写操作走 useMutate，成功后全部失效 */
/** 识别出来的画师（合集页的「画师」） */
export const useArtists = (enabled = true) => useQuery({ queryKey: qk.artists, queryFn: api.artists, enabled });

export const useCollections = (q: ListCollectionsQuery = {}, enabled = true) =>
  useQuery({ queryKey: qk.collections(q), queryFn: () => api.collections(q), placeholderData: keepPreviousData, enabled });
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

/** 图片列表（无限滚动），配合 components/media/ImageGrid 使用 */
export const useImagesInfinite = (q: Omit<ListImagesQuery, 'cursor'>) =>
  useInfiniteQuery({
    queryKey: qk.images(q),
    queryFn: ({ pageParam }) => api.images({ limit: 120, ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

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
  area: UnrecognizedArea;
  bucket?: UnrecognizedBucket;
  theme?: UnrecognizedTheme;
  kind?: UnrecognizedAnnexKind;
  artKind?: UnrecognizedArtKind;
}

export const useUnrecognizedInfinite = (p: UnrecognizedParams = { area: 'art' }, limit = 60) =>
  useInfiniteQuery({
    // 前缀仍是 'unrecognized'：全局失效照常覆盖
    queryKey: [...qk.unrecognized, p.area, p.bucket ?? 'all', p.theme ?? 'all', p.kind ?? 'all', p.artKind ?? 'all'],
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

export const useDuplicates = (resolved = false) =>
  useQuery({ queryKey: qk.duplicates(resolved), queryFn: () => api.duplicates({ resolved }) });

export const useExclusions = () => useQuery({ queryKey: qk.exclusions, queryFn: api.exclusions });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: qk.search(q),
    queryFn: () => api.search(q),
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

const NO_THEMES: CustomTheme[] = [];
/** 用户自己加的「画面」筛选（设置里的 browse.customThemes）；旧后端没有这一段时为空 */
export function useCustomThemes(): CustomTheme[] {
  const { data } = useSettings();
  return data?.browse?.customThemes ?? NO_THEMES;
}

/** 识别模型列表（设置页下拉框） */
export const useTaggerModels = () => useQuery({ queryKey: qk.taggerModels, queryFn: api.taggerModels });

export const useJobs = () => useQuery({ queryKey: qk.jobs, queryFn: api.jobs });

/** 后端版本、数据源（mock / sqlite）、数据目录；进程内不会变 */
export const useHealth = () => useQuery({ queryKey: qk.health, queryFn: api.health, staleTime: Infinity });

/** 移到回收站最近 5 次可以撤销，更早的已经放进系统回收站，要去那里还原 */
export const TRASH_HINT = '移到回收站（最近 5 次可撤销）';

// ------------------------------------------------------------------ 修改

export function invalidateAll(client: QueryClient) {
  return client.invalidateQueries();
}

const PLAIN_NOTE = '这一步不能撤销，需要的话请手动改回去（任务可以在设置里取消）。再按一次撤销会撤更早的操作。';
const TRASH_NOTE = '文件已经放进系统回收站，要找回请去系统回收站还原。再按一次撤销会撤更早的操作。';
const barrierId = () => `barrier:${crypto.randomUUID()}`;

/**
 * 一次写操作在撤销栈里记什么：有 token 记 token；回收站那种撤销不了的占位；
 * 其余改了图库 / 设置的写操作传 barrier（占位的说法）也占一格，Ctrl+Z 不会悄悄越过它去撤更早的
 */
export function entryOf(result: MutationResult, barrier?: string | null): UndoEntry | null {
  if (result.undoToken) return { token: result.undoToken, label: result.message };
  if (result.irreversible) return { token: barrierId(), label: result.message, barrier: true };
  if (barrier) return { token: barrierId(), label: barrier, barrier: true, note: PLAIN_NOTE };
  return null;
}

// 还在进行的写操作的占位：落定后给出 token（没做成是 false）
const pendingWaiters = new Map<string, { promise: Promise<string | null | false>; resolve: (t: string | null | false) => void }>();
// Ctrl+Z 已经在等的占位：落定时不再弹结果 toast，马上就撤掉了
const undoQueued = new Set<string>();

/** 写操作一开始就在撤销栈顶占个位置，免得请求还没回来时 Ctrl+Z 撤到上一步 */
export function beginPending(label: string, focus?: UndoFocus): string {
  const id = `pending:${crypto.randomUUID()}`;
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
    if (entry?.tokens) {
      for (const t of [...entry.tokens].reverse()) await api.undo(t);
      message = `已撤销：${entry.label}`;
    } else message = (await api.undo(token)).message;
    useUndoStore.getState().remove(token);
    // 别的页面做的：给个「去看看」；本页做的：刷新后把撤回来的东西指给用户看
    const where = afterUndone(entry);
    toast(message, where === 'elsewhere' && entry ? { action: { label: '去看看', onClick: () => goToUndone(entry) } } : undefined);
    await invalidateAll(client);
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
      return { ok: true, message: message(job), undoToken: null };
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
 * 通用修改 hook：成功 → toast（带撤销）+ 全部刷新；失败 → 错误 toast。
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
      await invalidateAll(client);
    },
    onError: (err, _vars, pending) => {
      if (pending) settlePending(pending, null, true);
      if (opts.onError) opts.onError(errorMessage(err), err);
      else toast.error(errorMessage(err));
    },
  });
}
