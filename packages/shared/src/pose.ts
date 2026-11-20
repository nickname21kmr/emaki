/**
 * 按姿势找图（实验，默认关）的接口类型。服务端在 apps/server/src/domain/pose/ 和 commands/pose.ts；
 * 设置在 Settings.pose，后台任务是 JOB_KINDS.pose（「提取姿势」）。
 */
import type { ImageItem, Job } from './domain.ts';

/** 取景组：全身、七分身（到膝）、半身（到腰）、胸像 */
export type PoseGroup = 'full' | 'mid' | 'waist' | 'bust';
export const POSE_GROUP_IDS = ['full', 'mid', 'waist', 'bust'] as const;

export interface PoseClass {
  /** full_01 这样 */
  id: string;
  group: PoseGroup;
  /** 简短的中文名（不带取景），例如「站立·双臂下垂·一手微抬」 */
  name: string;
  /** 完整描述（带取景） */
  description: string;
  /** 本图库里归到这一类、计入统计的图 */
  count: number;
  /** 示意小人（PNG，256×256，白底）：GET 这个地址 */
  figureUrl: string;
}

export interface PoseClassGroup {
  id: PoseGroup;
  name: string;
  /** 这一组里归了类的图 */
  count: number;
  classes: PoseClass[];
}

/** GET /api/pose/classes */
export interface PoseClassesResponse {
  groups: PoseClassGroup[];
}

/** 模型下载（后台进行，断点续传；取消后再点接着下） */
export interface PoseDownloadState {
  state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  file: string | null;
  received: number;
  total: number;
  message: string | null;
}

export interface PoseModelFile {
  name: string;
  size: number;
  present: boolean;
}

/** GET /api/pose/status */
export interface PoseStatus {
  /** 设置里打开了（Settings.pose.enabled） */
  enabled: boolean;
  models: {
    /** 两个模型都在、大小对得上 */
    ready: boolean;
    dir: string;
    files: PoseModelFile[];
    /** 本机能直接复制模型的文件夹（找到了才有），给「从本地复制」做默认值 */
    localSource: string | null;
    /** 下载源（Hugging Face 仓库） */
    repo: string;
    download: PoseDownloadState;
  };
  counts: {
    /** 要提取的图（计入统计的插画） */
    eligible: number;
    /** 已经按当前版本跑过 */
    processed: number;
    /** 还没跑（或版本旧了） */
    pending: number;
    /** 找到了能用的人物 */
    withPerson: number;
    /** 归进了某一类 */
    classified: number;
  };
  /** 本机有原型跑好的数据时给两个默认路径（「导入已有的姿势数据」用），没有是 null */
  prototype: { keypointsPath: string; assignmentsPath: string } | null;
  /** 正在跑或排队的「提取姿势」任务 */
  job: Job | null;
  /** PoseWear 姿势库：导入了多少姿势、多少张图有匹配；本机找得到时给两个导入的默认路径 */
  posewear: {
    poses: number;
    assigned: number;
    defaults: { folder: string | null; assignmentsPath: string | null };
  };
}

// ------------------------------------------------------------------ PoseWear 姿势库

/** PoseWear 的三套单人姿势（双人的 pair60 暂时不导） */
export type PoseWearSet = 'full_single' | 'full_sexy' | 'upper80v2';
export const POSEWEAR_SETS = ['full_single', 'full_sexy', 'upper80v2'] as const;
export const POSEWEAR_SET_LABEL: Record<PoseWearSet, string> = { full_single: '全身', full_sexy: '全身·性感', upper80v2: '上半身' };
/** 姿势 id：full_single_P001 这样 */
export const POSEWEAR_POSE_ID = /^(full_single|full_sexy|upper80v2)_P\d{3}$/;

export interface PoseWearPose {
  id: string;
  set: PoseWearSet;
  /** P001 */
  number: string;
  name: string;
  category: string;
  /** 主要匹配到这个姿势、计入统计的图 */
  count: number;
  /** 线稿小图（300×400 webp） */
  thumbUrl: string;
  /** 线稿大图（900×1200 webp，代表视角） */
  imageUrl: string;
}

export interface PoseWearCategory {
  name: string;
  count: number;
  poses: PoseWearPose[];
}

export interface PoseWearSetGroup {
  id: PoseWearSet;
  name: string;
  count: number;
  categories: PoseWearCategory[];
}

/** GET /api/pose/posewear：按套、分类分好组（默认只给有图的姿势，all=1 全给） */
export interface PoseWearCatalogResponse {
  sets: PoseWearSetGroup[];
  /** 导入了的姿势总数（不管有没有图） */
  poses: number;
}

export interface PoseWearMatch {
  pose: PoseWearPose;
  distance: number | null;
  tagScore: number | null;
  method: string | null;
  /** 匹配上的那个视角的小图（没有记视角时用代表视角） */
  viewThumbUrl: string;
}

/** GET /api/pose/posewear/of/:id：这张图的主要姿势和过了阈值的其他候选（最多 2 个） */
export interface PoseWearOfResponse {
  imageId: string;
  primary: (PoseWearMatch & { rank: number }) | null;
  related: PoseWearMatch[];
}

/** 导入 PoseWear 姿势库的结果 */
export interface PoseWearImportResult extends PoseActionResult {
  poses: number;
  files: number;
}

/** 导入姿势匹配结果的结果 */
export interface PoseWearAssignResult extends PoseActionResult {
  imported: number;
  candidates: number;
  /** 本图库里没有的图 */
  missing: number;
  /** 姿势库里没有的姿势（先导入姿势库） */
  unknownPose: number;
}

/** GET /api/pose/similar/:id 的一项 */
export interface PoseSimilarItem {
  image: ImageItem;
  /** 和那张图的骨架距离（0 = 一样，越大越不像；同一类里一般 < 0.3） */
  distance: number;
  /** 镜像之后更像 */
  mirror: boolean;
}

export interface PoseSimilarResponse {
  /** 那张图的姿势：没有姿势数据时 classId、group 都是 null，items 为空 */
  source: { imageId: string; classId: string | null; group: PoseGroup | null; status: string | null };
  items: PoseSimilarItem[];
  total: number;
  nextCursor: string | null;
}

/** POST /api/pose/models/download、/copy、/api/pose/import 的结果 */
export interface PoseActionResult {
  message: string;
}
