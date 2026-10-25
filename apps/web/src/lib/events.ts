import type { Job, JobItemEvent, ServerEvent } from '@emaki/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api } from './api';
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
 * library-changed → 让 query 失效（节流 400ms，避免扫描时疯狂刷新）。
 * 识别进行中每几秒来一次：排名类列表（作品网格、Top、最近在收）只标记过期、最多一分钟重拉一次，
 * 免得鼠标下的卡片不停换位（MS-6 / TR-12）；其余照常刷新。
 * 被压下的那次到时候要补上，不然识别结束前后的几次更新就一直停在过期状态，后面没有事件来补。
 */
export function createInvalidator(client: QueryClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rankTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRankRefresh = 0;
  const refreshRanks = () => {
    lastRankRefresh = Date.now();
    void client.invalidateQueries({ predicate: (q) => isRankQuery(q.queryKey) });
  };
  const invalidate = (reason?: 'scan' | 'tag' | 'mutation') => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const throttleRanks = reason === 'tag' && Date.now() - lastRankRefresh < 60_000;
      clearTimeout(rankTimer);
      if (!throttleRanks) lastRankRefresh = Date.now();
      // 一分钟到了再补拉一次；至少隔 11 秒，等后端 10 秒的软缓存过期，不然拉回来的还是旧的
      else rankTimer = setTimeout(refreshRanks, Math.max(lastRankRefresh + 60_000 - Date.now(), 11_000));
      const quiet = (key: readonly unknown[]) => (throttleRanks && isRankQuery(key)) || (reason === 'tag' && (isUnrecognizedList(key) || isDuplicates(key)));
      void client.invalidateQueries({ predicate: (q) => !quiet(q.queryKey) });
      void client.invalidateQueries({ predicate: (q) => quiet(q.queryKey), refetchType: 'none' });
    }, 400);
  };
  const dispose = () => {
    clearTimeout(timer);
    clearTimeout(rankTimer);
  };
  return { invalidate, dispose };
}

/** EventSource.CLOSED（node 跑测试时没有 EventSource） */
const CLOSED = 2;

/**
 * 连 /api/events，断了自己重连。网络错误时浏览器会自动重连；但开发时后端重启那十几秒里 vite 代理回 502，
 * EventSource 收到非 200 就直接关掉、再也不连，这里退避着重新建一个。
 */
export function openEventStream(
  on: { open: () => void; message: (data: string) => void; error?: () => void },
  make: () => EventSource = () => new EventSource('/api/events'),
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
 * 订阅后端 SSE。在 App 根部调用一次。
 * library-changed → 让 query 失效（见 createInvalidator）。
 * 连上 / 重连 → 用 GET /api/jobs 重置实时任务表。
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
      invalidate();
    };
    const onMessage = (data: string) => {
      const event = JSON.parse(data) as ServerEvent;
      switch (event.type) {
        case 'job':
          useLiveJobs.getState().upsert(event.job);
          if (event.job.status !== 'running') void client.invalidateQueries({ queryKey: qk.jobs });
          break;
        case 'library-changed':
          invalidate(event.reason);
          break;
        case 'stats':
          client.setQueryData(qk.stats, event.stats);
          break;
        case 'job-item':
          // 只做「在干活」的反馈，不让任何 query 失效
          useLiveJobs.getState().pushItem(event);
          break;
        case 'auto-change':
          void client.invalidateQueries({ queryKey: ['changes'] });
          // 自动关联改了用户建的角色：提一句在哪能撤回（Pixiv 补充一轮一条，太频繁，只刷新列表）
          if (event.change.kind === 'auto-associate') {
            toast(event.change.summary, { description: '不对的话，到「设置 → 识别 → 最近的自动改动」里撤回' });
          }
          break;
      }
    };
    // 断开期间记下的撤销不知道是哪次启动的，等重新连上再认领
    const close = openEventStream({ open: onOpen, message: onMessage, error: () => useUndoStore.getState().setBoot(null) });
    return () => {
      dispose();
      close();
    };
  }, [client]);
}
