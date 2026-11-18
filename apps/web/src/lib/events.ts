import type { CommandEvent, DomainChange, Job, JobItemEvent, LibraryChangedReason, ServerEvent } from '@emaki/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api, type CommandMeta } from './api';
import { qk } from './queries';
import { useUndoStore } from './stores';

/** 正在跑的后台任务（SSE 推送），给侧边栏 / 首页的进度条用。 */
interface JobsLive {
  jobs: Record<string, Job>;
  /** 识别胶卷（SEL-19）：每个任务最近识别完的几张，seq 全局递增 */
  items: Record<string, (JobItemEvent & { seq: number })[]>;
  /** 每收到一条 job-item 加 1：侧栏任务环跳一下 */
  beat: number;
  upsert: (job: Job) => void;
  pushItem: (item: JobItemEvent) => void;
  /** 用后端的任务列表整个替换（连上 / 重连 SSE 时） */
  reset: (jobs: Job[]) => void;
}

export const useLiveJobs = create<JobsLive>((set) => ({
  jobs: {},
  items: {},
  beat: 0,
  upsert: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  pushItem: (item) =>
    set((s) => ({
      beat: s.beat + 1,
      items: { ...s.items, [item.jobId]: [...(s.items[item.jobId] ?? []), { ...item, seq: s.beat + 1 }].slice(-6) },
    })),
  reset: (jobs) => set({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) }),
}));

/**
 * 正在运行的任务。队列分两条道（识别 / 其他）后最多同时两个：
 * 传 kind 取那一种；不传时识别优先（它最久，横幅和引导页要看它）。
 */
export const useRunningJob = (kind?: Job['kind']) =>
  useLiveJobs((s) => {
    const running = Object.values(s.jobs).filter((j) => j.status === 'running' && (!kind || j.kind === kind));
    return running.find((j) => j.kind === 'tag') ?? running[0] ?? null;
  });

/** 全部正在运行的任务（侧栏任务环），识别在前 */
export const useRunningJobs = () =>
  useLiveJobs(
    useShallow((s) =>
      Object.values(s.jobs)
        .filter((j) => j.status === 'running')
        .sort((a, b) => (a.kind === 'tag' ? -1 : b.kind === 'tag' ? 1 : 0)),
    ),
  );

/** 会随识别进度重新排序的列表：作品、Top 角色、最近在收 */
const isRankQuery = (key: readonly unknown[]) => key[0] === 'works' || (key[0] === 'characters' && key[1] === 'top');
/** 未识别的列表（不含汇总计数）：识别进行中只标记过期，由用户点「有新结果」再刷新（TR-12） */
const isUnrecognizedList = (key: readonly unknown[]) => key[0] === 'unrecognized' && key[1] !== 'summary';
/** 重复组：识别不会改变它，而真实库一次要传 6 MB（T22），识别期间只标记过期 */
const isDuplicates = (key: readonly unknown[]) => key[0] === 'duplicates';

/**
 * 每种变化要刷新哪些查询（按 queryKey 的第一段；附录 #36）。changed 事件带着这次变了的事实，前端只刷新相关的查询，
 * 不再每个修改都全部重新获取。图片上的决定会改各处的图、计数、封面，所以 IMAGE_VIEWS 一大组；
 * 查重（一次 6 MB）、排除规则、设置、模型列表这些只在相关的变化时刷新。撤销状态（undo-status）每次都刷新
 */
const IMAGE_VIEWS = [
  'images',
  'image',
  'image-count',
  'collections',
  'collection',
  'characters',
  'character',
  'works',
  'work',
  'search',
  'unrecognized',
  'stats',
  'summary',
  'content-kinds',
  'undo-status',
] as const;
const WITH_FILES = [...IMAGE_VIEWS, 'duplicates', 'changes', 'settings', 'artists'] as const;
export const REFRESH: Record<DomainChange, readonly string[]> = {
  'image.added': WITH_FILES,
  'image.gone': WITH_FILES,
  'image.returned': WITH_FILES,
  'image.fileChanged': WITH_FILES,
  'image.moved': WITH_FILES,
  'image.trashed': WITH_FILES,
  'image.restored': WITH_FILES,
  'root.visibilityChanged': WITH_FILES,
  'root.modeChanged': WITH_FILES,
  'image.kindChanged': IMAGE_VIEWS,
  'image.animatedChanged': IMAGE_VIEWS,
  'image.sourceChanged': IMAGE_VIEWS,
  'evidence.changed': [...IMAGE_VIEWS, 'tags', 'custom-character-matches'],
  'curation.charactersChanged': IMAGE_VIEWS,
  'curation.originalChanged': IMAGE_VIEWS,
  'curation.shelvedChanged': IMAGE_VIEWS,
  'curation.ratingChanged': IMAGE_VIEWS,
  'curation.favoriteChanged': IMAGE_VIEWS,
  'curation.artistsChanged': [...IMAGE_VIEWS, 'artists'],
  'curation.vetoesChanged': IMAGE_VIEWS,
  'catalog.characterChanged': [...IMAGE_VIEWS, 'custom-character-matches', 'changes'],
  'catalog.merged': [...IMAGE_VIEWS, 'custom-character-matches', 'changes'],
  'catalog.bindingChanged': [...IMAGE_VIEWS, 'custom-character-matches', 'changes'],
  'visibility.rulesChanged': [...IMAGE_VIEWS, 'exclusions', 'duplicates'],
  'visibility.changed': [...IMAGE_VIEWS, 'exclusions', 'duplicates'],
  'collections.changed': IMAGE_VIEWS,
  'duplicates.changed': ['duplicates', 'stats', 'summary', 'undo-status'],
  'settings.changed': [...IMAGE_VIEWS, 'settings', 'tagger-models'],
  'library.opened': [...WITH_FILES, 'exclusions', 'tags', 'custom-character-matches'],
};

/** 命令本身没声明变化（画师的合并关系、标记看过、启动任务……）时按命令刷新；不在这里的就什么也不刷 */
const BY_COMMAND: Record<string, readonly string[]> = {
  'catalog.linkArtists': ['artists', 'images', 'image', 'collections', 'collection', 'undo-status'],
  'catalog.markSeen': ['characters', 'character'],
  'jobs.start': ['jobs'],
  'jobs.cancel': ['jobs'],
  'unrecognized.retag': ['jobs', 'unrecognized'],
  'history.undo': ['undo-status'],
};

/** 这些变化要刷新的查询（第一段）；null 是全部 */
export function rootsFor(changes: readonly DomainChange[] | null | undefined, command?: string): Set<string> | null {
  if (!changes) return null;
  const roots = new Set<string>(command ? (BY_COMMAND[command] ?? []) : []);
  for (const c of changes) {
    const r = REFRESH[c];
    if (!r) return null; // 不认识的变化（新后端）：全部刷新
    for (const k of r) roots.add(k);
  }
  return roots;
}

/**
 * changed 事件 → 只让相关的 query 失效。用户和助手的操作马上刷新；后台任务的（扫描、识别……）节流 400ms，避免扫描时疯狂刷新。
 * 识别进行中每几秒来一次：排名类列表（作品网格、Top、最近在收）只标记过期、最多一分钟重拉一次，
 * 免得鼠标下的卡片不停换位（MS-6 / TR-12）；其余照常刷新。
 * 被压下的那次到时候要补上，不然识别结束前后的几次更新就一直停在过期状态，后面没有事件来补。
 *
 * invalidate 返回这次刷新的 promise（写操作等它，刷新完再算做完：前端只刷新一遍，见 settleRefresh）。
 * changes 不给（null）= 全部刷新（重连补不上、旧后端）
 */
export function createInvalidator(client: QueryClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rankTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRankRefresh = 0;
  // 攒着还没刷的：要刷的查询（null = 全部）、最后一次的 reason、等着它的 promise
  let pending: { roots: Set<string> | null; reason?: LibraryChangedReason; done: Promise<void>; resolve: () => void } | null = null;
  const refreshRanks = () => {
    lastRankRefresh = Date.now();
    void client.invalidateQueries({ predicate: (q) => isRankQuery(q.queryKey) });
  };
  const flush = () => {
    const p = pending;
    pending = null;
    clearTimeout(timer);
    if (!p) return;
    const reason = p.reason;
    const throttleRanks = reason === 'tag' && Date.now() - lastRankRefresh < 60_000;
    const hit = (key: readonly unknown[]) => !p.roots || p.roots.has(String(key[0]));
    if (!p.roots || [...p.roots].some((r) => r === 'works' || r === 'characters')) {
      clearTimeout(rankTimer);
      if (!throttleRanks) lastRankRefresh = Date.now();
      // 一分钟到了再补拉一次；至少隔 11 秒，等后端 10 秒的软缓存过期，不然拉回来的还是旧的
      else rankTimer = setTimeout(refreshRanks, Math.max(lastRankRefresh + 60_000 - Date.now(), 11_000));
    }
    const quiet = (key: readonly unknown[]) =>
      (throttleRanks && isRankQuery(key)) || (reason === 'tag' && (isUnrecognizedList(key) || isDuplicates(key)));
    void Promise.all([
      client.invalidateQueries({ predicate: (q) => hit(q.queryKey) && !quiet(q.queryKey) }),
      client.invalidateQueries({ predicate: (q) => hit(q.queryKey) && quiet(q.queryKey), refetchType: 'none' }),
    ]).finally(p.resolve);
  };
  // reason：'mutation' 是用户或助手的操作，任务种类（scan、tag、thumbnail…）是那个后台任务写的库，'system' 是启动修补
  const invalidate = (reason?: LibraryChangedReason, changes: readonly DomainChange[] | null = null, command?: string): Promise<void> => {
    const roots = rootsFor(changes, command);
    if (!pending) {
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      pending = { roots: new Set(), reason, done, resolve };
    }
    const cur = pending;
    cur.roots = roots && cur.roots ? new Set([...cur.roots, ...roots]) : null;
    cur.reason = reason;
    clearTimeout(timer);
    // 用户、助手的操作：马上刷新（同一轮里来的几条合在一起）；后台任务：节流
    timer = setTimeout(flush, reason === 'mutation' ? 0 : 400);
    return cur.done;
  };
  const dispose = () => {
    clearTimeout(timer);
    clearTimeout(rankTimer);
  };
  return { invalidate, dispose };
}

// ------------------------------------------------------------------ 事件 id：写操作等自己的那条事件（只刷新一遍）

/** 这次连着的后端的启动 id、收到的最后一条可补发事件的 id */
const position = { boot: null as string | null, last: 0 };
/** 每条 changed 事件触发的那次刷新（写操作等它） */
const refreshes = new Map<number, Promise<void>>();
const seenWaiters = new Set<{ id: number; resolve: (seen: boolean) => void }>();

function noteEvent(id: number, refresh?: Promise<void>) {
  if (refresh) {
    refreshes.set(id, refresh);
    if (refreshes.size > 200) refreshes.delete(refreshes.keys().next().value!);
  }
  if (id > position.last) position.last = id;
  for (const w of seenWaiters) if (position.last >= w.id) (seenWaiters.delete(w), w.resolve(true));
}

/** 测试用：重置事件位置 */
export function resetEventPosition(boot: string | null = null, last = 0) {
  position.boot = boot;
  position.last = last;
  refreshes.clear();
}

/** 等 id 这条事件到（SSE 断着、或者等太久就算没到） */
export function eventSeen(id: number, timeoutMs = 1500): Promise<boolean> {
  if (position.last >= id) return Promise.resolve(true);
  return new Promise((resolve) => {
    const w = { id, resolve };
    seenWaiters.add(w);
    setTimeout(() => {
      if (seenWaiters.delete(w)) resolve(false);
    }, timeoutMs);
  });
}

/**
 * 写操作成功后：命令层在响应头里给了这次推出去的最后一条 changed 事件的 id。SSE 已经（或者马上）按事件类型刷新了相关的查询，
 * 这里等那次刷新做完就行，不再自己全部重新获取一遍（附录 #36：以前每个修改要拉两遍）。SSE 断着、等不到时自己按变化类型刷新。
 * 不是命令的接口（或者旧后端，没有说明）照旧全部刷新
 */
export async function settleRefresh(client: QueryClient, meta: CommandMeta | undefined): Promise<void> {
  if (!meta) return void (await client.invalidateQueries());
  if (meta.eventId === null) {
    const roots = rootsFor([], meta.command);
    if (roots?.size) await client.invalidateQueries({ predicate: (q) => roots.has(String(q.queryKey[0])) });
    return;
  }
  if (await eventSeen(meta.eventId)) return void (await refreshes.get(meta.eventId));
  const roots = rootsFor(meta.changes, meta.command);
  await client.invalidateQueries(roots ? { predicate: (q) => roots.has(String(q.queryKey[0])) } : undefined);
}

/** AI 助手做的、可撤销的修改：放进网页的撤销栈（按 boot 认领，后端重启过的不要；已经有这条的不重复） */
export function adoptCommand(event: CommandEvent) {
  if (event.actor === 'user' || event.undo !== 'token' || !event.undoToken) return;
  const store = useUndoStore.getState();
  if (store.boot && event.boot !== store.boot) return;
  if (store.entries.some((e) => e.token === event.undoToken)) return;
  store.push({
    token: event.undoToken,
    label: `${event.actor === 'assistant' ? '助手：' : ''}${event.message}`,
    by: event.actor,
    ...(event.imageIds?.length ? { focus: { images: event.imageIds } } : {}),
  });
}

/** 重新建连接时带上收到的最后一条的 id（浏览器自己重连时会带 Last-Event-ID，这里补上手动重建的情况） */
const eventsUrl = () =>
  position.boot && position.last ? `/api/events?lastEventId=${encodeURIComponent(`${position.boot}.${position.last}`)}` : '/api/events';

/** EventSource.CLOSED（node 跑测试时没有 EventSource） */
const CLOSED = 2;

/**
 * 连 /api/events，断了自己重连。网络错误时浏览器会自动重连；但开发时后端重启那十几秒里 vite 代理回 502，
 * EventSource 收到非 200 就直接关掉、再也不连，这里退避着重新建一个。
 */
export function openEventStream(
  on: { open: () => void; message: (data: string) => void; error?: () => void },
  make: () => EventSource = () => new EventSource(eventsUrl()),
): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  const connect = () => {
    const s = make();
    source = s;
    s.onopen = () => {
      delay = 1000;
      on.open();
    };
    s.onmessage = (msg: MessageEvent) => on.message(msg.data as string);
    s.onerror = () => {
      on.error?.();
      if (s.readyState !== CLOSED) return; // 还在 CONNECTING：浏览器自己会重连
      s.close();
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  connect();
  return () => {
    clearTimeout(retry);
    source?.close();
  };
}

/**
 * 一条 SSE 事件（useServerEvents 收到的，测试也直接调）：changed 按变化类型刷新并记下事件 id（写操作等它）；
 * command 是 AI 助手做的、可撤销的修改时放进撤销栈；resync 全部刷新；hello 记下这次连着的后端和位置
 */
export function handleServerEvent(client: QueryClient, invalidate: ReturnType<typeof createInvalidator>['invalidate'], event: ServerEvent) {
  switch (event.type) {
    case 'hello':
      // 后端重启过：位置从头算（resync 已经让前端全部刷新）
      if (position.boot !== event.boot) resetEventPosition(event.boot, event.lastId);
      else noteEvent(event.lastId);
      break;
    case 'resync':
      void invalidate(undefined, null);
      break;
    case 'job':
      useLiveJobs.getState().upsert(event.job);
      if (event.job.status !== 'running') void client.invalidateQueries({ queryKey: qk.jobs });
      break;
    case 'changed':
      noteEvent(event.id, invalidate(event.reason, event.changes.length || event.command ? event.changes : null, event.command));
      break;
    case 'command':
      noteEvent(event.id);
      adoptCommand(event);
      break;
    case 'job-item':
      // 只做「在干活」的反馈，不让任何 query 失效
      useLiveJobs.getState().pushItem(event);
      break;
    case 'auto-change':
      noteEvent(event.id);
      void client.invalidateQueries({ queryKey: ['changes'] });
      // 自动关联改了用户建的角色：提一句在哪能撤回（Pixiv 补充一轮一条，太频繁，只刷新列表）
      if (event.change.kind === 'auto-associate') {
        toast(event.change.summary, { description: '不对的话，到「设置 → 识别 → 最近的自动改动」里撤回' });
      }
      // 重新识别后证据不再支持、自动撤回了关联：说一声在哪能加回来
      if (event.change.kind === 'auto-retract') {
        toast(event.change.summary, { description: '要加回来的话，到「设置 → 识别 → 最近的自动改动」里撤回' });
      }
      break;
  }
}

/**
 * 订阅后端 SSE。在 App 根部调用一次。
 * changed → 只让相关的 query 失效（见 createInvalidator）；command → AI 助手做的、可撤销的修改放进撤销栈；
 * resync（断线太久或者后端重启过，补发不了）→ 全部刷新。
 * 连上 / 重连 → 用 GET /api/jobs 重置实时任务表；漏掉的事件服务端按 Last-Event-ID 补发。
 */
export function useServerEvents() {
  const client = useQueryClient();
  useEffect(() => {
    const { invalidate, dispose } = createInvalidator(client);
    // 连上（包括后端重启后重连）时以后端为准：后端重启会丢掉跑到一半的任务，
    // 不重置的话页面会一直显示那个已经不存在的「正在识别」
    const onOpen = () => {
      api
        .jobs()
        .then((jobs) => {
          useLiveJobs.getState().reset(jobs);
          client.setQueryData(qk.jobs, jobs);
        })
        .catch(() => {});
      // 后端重启过的话，它的撤销栈已经空了：丢掉之前记下的撤销
      api
        .health()
        .then((h) => h.bootId && useUndoStore.getState().setBoot(h.bootId))
        .catch(() => {});
    };
    const onMessage = (data: string) => handleServerEvent(client, invalidate, JSON.parse(data) as ServerEvent);
    // 断开期间记下的撤销不知道是哪次启动的，等重新连上再认领
    const close = openEventStream({ open: onOpen, message: onMessage, error: () => useUndoStore.getState().setBoot(null) });
    return () => {
      dispose();
      close();
    };
  }, [client]);
}
