/**
 * 所有数据读取 / 修改的 React hook。页面只用这里的 hook。
 *
 * 缓存失效策略很简单：任何修改成功后 invalidate 全部 query（本地应用，数据量小，请求都很快），
 * 另外后端通过 SSE 推 `library-changed` 时也会全部失效（见 lib/events.ts）。
 */
import { showResultToast, undoViaToast } from '@/components/ui/Toast';
import type {
  Character,
  CustomTheme,
  GetCharacterResponse,
  ID,
  Job,
  JobKind,
  ListCharactersQuery,
  ListCollectionsQuery,
  UnrecognizedAnnexKind,
  UnrecognizedArea,
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
import { useUndoStore } from './stores';

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

/** 未识别列表的参数（T34b）：大类、分段、主题、别册类型 */
export interface UnrecognizedParams {
  area: UnrecognizedArea;
  bucket?: UnrecognizedBucket;
  theme?: UnrecognizedTheme;
  kind?: UnrecognizedAnnexKind;
}

export const useUnrecognizedInfinite = (p: UnrecognizedParams = { area: 'art' }, limit = 60) =>
  useInfiniteQuery({
    // 前缀仍是 'unrecognized'：全局失效照常覆盖
    queryKey: [...qk.unrecognized, p.area, p.bucket ?? 'all', p.theme ?? 'all', p.kind ?? 'all'],
    queryFn: ({ pageParam }) => api.unrecognized({ ...p, limit, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useUnrecognizedSummary = () =>
  useQuery({ queryKey: [...qk.unrecognized, 'summary'], queryFn: api.unrecognizedSummary, staleTime: 5_000 });

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

/** 真实数据的「移到回收站」不能在 Emaki 里撤销（只能去系统回收站还原）；演示数据可以 */
export const useCanUndoTrash = () => useHealth().data?.dataSource === 'mock';
export const useTrashHint = () => (useCanUndoTrash() ? '移到系统回收站（可撤销）' : '移到系统回收站（可在回收站里还原）');

// ------------------------------------------------------------------ 修改

export function invalidateAll(client: QueryClient) {
  return client.invalidateQueries();
}

/** 显示结果 toast；带 undoToken 的附带「撤销」按钮，并记入顶栏撤销栈。 */
export function announce(result: MutationResult, client: QueryClient) {
  // 墨色胶囊 + 朱色引信（SEL-11）；可撤销的记入顶栏撤销栈
  if (result.undoToken) useUndoStore.getState().push({ token: result.undoToken, label: result.message });
  showResultToast(result.message, result.undoToken, client);
}

export async function undo(token: string, client: QueryClient) {
  // 这条的 toast 还在：交给它撤销，胶囊原地变成「已撤销」
  if (undoViaToast(token)) return;
  try {
    const res = await api.undo(token);
    useUndoStore.getState().remove(token);
    toast(res.message);
    await invalidateAll(client);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

/**
 * 启动后台任务。startJob 返回 Job 而不是 MutationResult，这里统一包一层：toast + 刷新，
 * 并先把任务写进实时任务表（SSE 可能比响应先到；已有记录时别用旧快照覆盖）。
 *   const start = useStartJob((job) => `已开始${job.kind}`);  start.mutate('scan');
 */
export function useStartJob(message: (job: Job) => string) {
  return useMutate((kind: JobKind) =>
    api.startJob(kind).then((job): MutationResult => {
      const live = useLiveJobs.getState();
      if (!live.jobs[job.id]) live.upsert(job);
      return { ok: true, message: message(job), undoToken: null };
    }),
  );
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
  } = {},
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      if (!opts.silent) announce(result, client);
      opts.onSuccess?.(result, vars);
      await invalidateAll(client);
    },
    onError: (err) => {
      if (opts.onError) opts.onError(errorMessage(err), err);
      else toast.error(errorMessage(err));
    },
  });
}
