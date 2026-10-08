import type {
  ID,
  Job,
  JobKind,
  JobStatus,
  LibraryRoot,
  MutationResult,
  Settings,
  UpdateSettingsBody,
  UpdateLibraryRootBody,
} from '@emaki/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useScrollContainer } from '@/components/layout/ScrollContainer';
import { api } from '@/lib/api';
import { useLiveJobs } from '@/lib/events';
import { qk, useJobs, useMutate, useStartJob as useStartJobBase } from '@/lib/queries';
import { isActiveJob, JOB_LABEL } from './jobMeta';
import { SECTIONS, sectionDomId, type SectionId } from './sections';

/** 没有撤销的简单结果，交给 useMutate 统一出 toast */
const done = (message: string): MutationResult => ({ ok: true, message, undoToken: null });

// ------------------------------------------------------------------ 设置

/** 把局部修改合进当前设置，做乐观更新（切主题要立刻生效，不等请求回来） */
function applyPatch(prev: Settings, body: UpdateSettingsBody): Settings {
  const { danbooruApiKey, ...rest } = body;
  return {
    ...prev,
    tagger: { ...prev.tagger, ...rest.tagger },
    danbooru: {
      ...prev.danbooru,
      ...rest.danbooru,
      ...(danbooruApiKey !== undefined ? { hasApiKey: danbooruApiKey.length > 0 } : {}),
    },
    dedupe: { ...prev.dedupe, ...rest.dedupe },
    ui: { ...prev.ui, ...rest.ui },
    browse: { ...prev.browse, ...rest.browse },
  };
}

/**
 * 保存设置：先改本地缓存，再 PUT；成功 toast「已保存」，失败以服务端为准重新拉取。
 *   const save = useSaveSettings();
 *   save({ ui: { theme: 'dark' } });
 */
export function useSaveSettings() {
  const client = useQueryClient();
  const { mutate } = useMutate((body: UpdateSettingsBody) => api.updateSettings(body).then(() => done('已保存')));
  return useCallback(
    (body: UpdateSettingsBody) => {
      const prev = client.getQueryData<Settings>(qk.settings);
      if (prev) client.setQueryData<Settings>(qk.settings, applyPatch(prev, body));
      mutate(body, { onError: () => void client.invalidateQueries({ queryKey: qk.settings }) });
    },
    [client, mutate],
  );
}

function patchRoots(client: QueryClient, fn: (roots: LibraryRoot[]) => LibraryRoot[]) {
  client.setQueryData<Settings>(qk.settings, (s) => (s ? { ...s, libraryRoots: fn(s.libraryRoots) } : s));
}

/** 改文件夹：启用 / 停用、按漫画导入、漫画的分级（乐观更新，开关不等网络） */
export function useUpdateRoot() {
  const client = useQueryClient();
  const { mutate } = useMutate((v: { id: ID; body: UpdateLibraryRootBody }) => api.updateLibraryRoot(v.id, v.body));
  return useCallback(
    (id: ID, body: UpdateLibraryRootBody) => {
      const { comicFolder: _f, removeComicFolder: _r, ...own } = body;
      patchRoots(client, (roots) => roots.map((r) => (r.id === id ? { ...r, ...own } : r)));
      mutate({ id, body }, { onError: () => void client.invalidateQueries({ queryKey: qk.settings }) });
    },
    [client, mutate],
  );
}

/** 移除文件夹：行先动画移出，toast 里可以撤销 */
export function useRemoveRoot() {
  const client = useQueryClient();
  const { mutate } = useMutate((id: ID) => api.removeLibraryRoot(id));
  return useCallback(
    (id: ID) => {
      patchRoots(client, (roots) => roots.filter((r) => r.id !== id));
      mutate(id, { onError: () => void client.invalidateQueries({ queryKey: qk.settings }) });
    },
    [client, mutate],
  );
}

// ------------------------------------------------------------------ 后台任务

export function useStartJob() {
  return useStartJobBase((job) => (job.status === 'queued' ? `已加入队列：${JOB_LABEL[job.kind]}` : `已开始${JOB_LABEL[job.kind]}`));
}

export function useCancelJob() {
  return useMutate((id: ID) => api.cancelJob(id).then(() => done('已取消任务')));
}

const STATUS_RANK: Record<JobStatus, number> = { queued: 0, running: 1, done: 2, failed: 2, cancelled: 2 };

/** 同一任务的两份快照取更新的那份：终态 > 运行中 > 排队，同阶段看进度 */
function newer(a: Job, b: Job): Job {
  const ra = STATUS_RANK[a.status];
  const rb = STATUS_RANK[b.status];
  if (ra !== rb) return ra > rb ? a : b;
  return b.progress >= a.progress ? b : a;
}

const jobTime = (j: Job) => j.startedAt ?? j.finishedAt ?? '';

function compareJobs(a: Job, b: Job): number {
  // 运行中 → 排队 → 其余按时间倒序
  const order = (j: Job) => (j.status === 'running' ? 0 : j.status === 'queued' ? 1 : 2);
  return order(a) - order(b) || jobTime(b).localeCompare(jobTime(a));
}

/** GET /api/jobs 的列表 + SSE 推来的实时进度，合并去重 */
export function useMergedJobs() {
  const query = useJobs();
  const live = useLiveJobs((s) => s.jobs);
  const jobs = useMemo(() => {
    const map = new Map<string, Job>();
    for (const j of query.data ?? []) map.set(j.id, j);
    for (const j of Object.values(live)) {
      const prev = map.get(j.id);
      map.set(j.id, prev ? newer(prev, j) : j);
    }
    return [...map.values()].sort(compareJobs);
  }, [query.data, live]);
  return { jobs, isPending: query.isPending, error: query.error, refetch: query.refetch };
}

/** 某类任务正在跑（或排队）时返回它，给「立即扫描」这类按钮切换成进度条 */
export function useActiveJob(kind: JobKind): Job | null {
  const { jobs } = useMergedJobs();
  return jobs.find((j) => j.kind === kind && isActiveJob(j)) ?? null;
}

/** 每秒走一次的时钟，只在需要时（有任务在跑）开启 */
export function useNow(enabled: boolean, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [enabled, ms]);
  return now;
}

// ------------------------------------------------------------------ 目录 / 滚动定位

const FIRST: SectionId = SECTIONS[0].id;
const LAST: SectionId = SECTIONS[SECTIONS.length - 1]?.id ?? FIRST;

/**
 * 左侧目录的高亮 + 点击跳转。滚动容器是 AppShell 的「纸」而不是 window。
 * 点击后锁住高亮一小会儿，避免平滑滚动途中高亮在各节之间闪。
 */
export function useSectionNav(ready: boolean) {
  const scrollRef = useScrollContainer();
  const [active, setActive] = useState<SectionId>(FIRST);
  const lockUntil = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !ready) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      if (Date.now() < lockUntil.current) return;
      // 到底了就算最后一节（「关于」很短，永远顶不到上面）
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) return setActive(LAST);
      const top = el.getBoundingClientRect().top;
      let current = FIRST;
      for (const s of SECTIONS) {
        const node = document.getElementById(sectionDomId(s.id));
        if (node && node.getBoundingClientRect().top - top <= 160) current = s.id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    compute();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, ready]);

  const jump = useCallback((id: SectionId, behavior: ScrollBehavior = 'smooth') => {
    const node = document.getElementById(sectionDomId(id));
    if (!node) return;
    lockUntil.current = Date.now() + 900;
    setActive(id);
    node.scrollIntoView({ behavior, block: 'start' });
  }, []);

  return { active, jump };
}
