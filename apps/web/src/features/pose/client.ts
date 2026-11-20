import type {
  ID,
  ImageItem,
  Job,
  ListImagesResponse,
  PoseActionResult,
  PoseClass,
  PoseClassesResponse,
  PoseSimilarResponse,
  PoseStatus,
  PoseWearAssignResult,
  PoseWearCatalogResponse,
  PoseWearImportResult,
  PoseWearOfResponse,
  PoseWearPose,
} from '@emaki/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { useSettings } from '@/lib/queries';

/**
 * 按姿势找图（实验，默认关）：接口和查询。这个文件在主包里，只放小东西；
 * 界面（设置一节、按姿势、看图器那一行）在 ui.tsx / PoseSettingsSection.tsx，打开后才懒加载。
 * 查询键都以 'pose' 开头：pose.changed、settings.changed 事件会让它们重新拉。
 */
export const poseApi = {
  status: () => request<PoseStatus>('GET', '/pose/status'),
  download: () => request<PoseActionResult>('POST', '/pose/models/download', { consent: true }),
  cancelDownload: () => request<PoseActionResult>('DELETE', '/pose/models/download'),
  copy: (path: string) => request<PoseActionResult>('POST', '/pose/models/copy', { path }),
  extract: () => request<Job>('POST', '/pose/extract', {}),
  importPrototype: (body: { keypointsPath: string; assignmentsPath: string }) =>
    request<PoseActionResult & { imported: number; classified: number; missing: number; skipped: number }>('POST', '/pose/import', body),
  classes: () => request<PoseClassesResponse>('GET', '/pose/classes'),
  similar: (id: ID, cursor?: string, limit = 60) =>
    request<PoseSimilarResponse>('GET', `/pose/similar/${encodeURIComponent(id)}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  // PoseWear 姿势库
  importPoseWear: (body: { path: string; viewsPath?: string }) => request<PoseWearImportResult>('POST', '/pose/posewear/import', body),
  importPoseWearMatches: (assignmentsPath: string) => request<PoseWearAssignResult>('POST', '/pose/posewear/matches', { assignmentsPath }),
  posewear: (all: boolean) => request<PoseWearCatalogResponse>('GET', `/pose/posewear${all ? '?all=1' : ''}`),
  posewearOf: (id: ID) => request<PoseWearOfResponse>('GET', `/pose/posewear-match/${encodeURIComponent(id)}`),
};

/** 设置里打开了没有（没加载出来按关着算） */
export function usePoseEnabled(): boolean {
  return useSettings().data?.pose?.enabled ?? false;
}

/** 51 类的界面（按人偶挑、找同姿势的图）：设置里另开，默认藏起来 */
export function usePoseClassesShown(): boolean {
  const pose = useSettings().data?.pose;
  return !!pose?.enabled && !!pose.showClasses;
}

/** PoseWear 姿势目录；all = 连没有图的姿势也要 */
export function usePoseWear(enabled: boolean, all = false) {
  return useQuery({ queryKey: ['pose', 'posewear', all], queryFn: () => poseApi.posewear(all), enabled, staleTime: 60_000 });
}

/** 按 id 找 PoseWear 姿势 */
export function findPoseWear(data: PoseWearCatalogResponse | undefined, id: string | undefined): PoseWearPose | undefined {
  if (!data || !id) return undefined;
  for (const s of data.sets) for (const c of s.categories) for (const p of c.poses) if (p.id === id) return p;
  return undefined;
}

/** 一张图匹配到的 PoseWear 姿势 */
export function usePoseWearOf(id: ID | undefined, enabled: boolean) {
  return useQuery({ queryKey: ['pose', 'posewear-of', id], queryFn: () => poseApi.posewearOf(id!), enabled: enabled && !!id, staleTime: 60_000 });
}

/** 状态：下载或提取进行中时两秒一次（下载没有 SSE 事件） */
export function usePoseStatus() {
  return useQuery({
    queryKey: ['pose', 'status'],
    queryFn: poseApi.status,
    refetchInterval: (q) => (q.state.data?.models.download.state === 'running' || q.state.data?.job ? 2000 : false),
  });
}

export function usePoseClasses(enabled: boolean) {
  return useQuery({ queryKey: ['pose', 'classes'], queryFn: poseApi.classes, enabled, staleTime: 60_000 });
}

/** 按 id 找类别（找不到 = 类别还没加载或 id 不对） */
export function findPoseClass(data: PoseClassesResponse | undefined, id: string | undefined): PoseClass | undefined {
  if (!data || !id) return undefined;
  for (const g of data.groups) for (const c of g.classes) if (c.id === id) return c;
  return undefined;
}

/** 一张图的姿势：只要 source（类别、没找到人物的原因），所以 limit=1 */
export function usePoseOf(id: ID | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['pose', 'of', id],
    queryFn: () => poseApi.similar(id!, undefined, 1).then((r) => r.source),
    enabled: enabled && !!id,
    staleTime: 60_000,
  });
}

/** 「找同姿势的图」的列表：页的形状换成和图片列表一样，网格直接用 */
export function usePoseSimilarInfinite(id: ID | undefined) {
  return useInfiniteQuery({
    queryKey: ['pose', 'similar', id],
    queryFn: async ({ pageParam }): Promise<ListImagesResponse> => {
      const r = await poseApi.similar(id!, pageParam, 120);
      const items: ImageItem[] = r.items.map((it) => it.image);
      return { items, total: r.total, nextCursor: r.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled: !!id,
  });
}
