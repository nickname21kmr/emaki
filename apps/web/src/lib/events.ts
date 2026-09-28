import type { Job, JobItemEvent, ServerEvent } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api } from './api';
import { qk } from './queries';

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
 * 订阅后端 SSE。在 App 根部调用一次。
 * library-changed → 让全部 query 失效（节流 400ms，避免扫描时疯狂刷新）。
 * 连上 / 重连 → 用 GET /api/jobs 重置实时任务表。
 */
export function useServerEvents() {
  const client = useQueryClient();
  useEffect(() => {
    let timer: number | undefined;
    let lastRankRefresh = 0;
    const invalidate = (reason?: 'scan' | 'tag' | 'mutation') => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // 识别进行中每几秒来一次：排名类列表（作品网格、Top、最近在收）只标记过期、最多一分钟重拉一次，
        // 免得鼠标下的卡片不停换位（MS-6 / TR-12）；其余照常刷新
        const throttleRanks = reason === 'tag' && Date.now() - lastRankRefresh < 60_000;
        if (!throttleRanks) lastRankRefresh = Date.now();
        const quiet = (key: readonly unknown[]) => (throttleRanks && isRankQuery(key)) || (reason === 'tag' && (isUnrecognizedList(key) || isDuplicates(key)));
        void client.invalidateQueries({ predicate: (q) => !quiet(q.queryKey) });
        void client.invalidateQueries({ predicate: (q) => quiet(q.queryKey), refetchType: 'none' });
      }, 400);
    };
    const source = new EventSource('/api/events');
    // 连上（包括后端重启后浏览器自动重连）时以后端为准：后端重启会丢掉跑到一半的任务，
    // 不重置的话页面会一直显示那个已经不存在的「正在识别」
    source.onopen = () => {
      api
        .jobs()
        .then((jobs) => {
          useLiveJobs.getState().reset(jobs);
          client.setQueryData(qk.jobs, jobs);
        })
        .catch(() => {});
      invalidate();
    };
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data as string) as ServerEvent;
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
      }
    };
    return () => {
      window.clearTimeout(timer);
      source.close();
    };
  }, [client]);
}
