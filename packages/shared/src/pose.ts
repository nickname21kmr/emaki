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
    /** 模型文件都在、大小对得上（找人：deepghs 动漫人物检测；骨架：DWPose） */
    ready: boolean;
    /** DWPose 所在的文件夹 */
    dir: string;
    /** 每个文件（name 是仓库里的路径，例如 person_detect_v1.1_m/model.onnx） */
    files: PoseModelFile[];
    /** 本机能直接复制模型的文件夹（找到了才有），给「从本地复制」做默认值 */
    localSource: string | null;
    /** 下载源（Hugging Face 仓库，几个用「、」连起来） */
    repo: string;
    download: PoseDownloadState;
  };
  counts: {
    /** 要提取的图（计入统计的插画） */
    eligible: number;
    /** 提取过的（任何版本） */
    processed: number;
    /** 还没提取过（「提取姿势」会自动跑这些） */
    pending: number;
    /** 提取过、但用的是旧的找人模型（YOLOX）：结果照常用；要重跑点「用新的找人模型重新提取」（pose.reextract） */
    outdated: number;
    /** 找到了能用的人物 */
    withPerson: number;
    /** 归进了某一类 */
    classified: number;
  };
  /** 用户要求了用新的找人模型重新提取、还没重提完（旧版本的那些会跟着「提取姿势」一起跑） */
  rerun: boolean;
  /** 姿势标签的低分（image_pose_tags_low）：识别时顺便收；识别过的旧图要「补充姿势标签」（pose.backfillTags） */
  tags: PoseTagsStatus;
  /** 本机有原型跑好的数据时给两个默认路径（「导入已有的姿势数据」用），没有是 null */
  prototype: { keypointsPath: string; assignmentsPath: string } | null;
  /** 正在跑或排队的「提取姿势」任务 */
  job: Job | null;
  /** PoseWear 姿势库：导入了多少姿势、多少张图有匹配；本机找得到时给两个导入的默认路径 */
  posewear: {
    /** 单人姿势数 */
    poses: number;
    /** 有单人匹配的图 */
    assigned: number;
    /** 单人的图-姿势对（一张图可以在几个姿势下） */
    pairs: number;
    /** 其中低置信的对 */
    low: number;
    /** 双人：类型数、有匹配的图、去掉差分后显示的图 */
    pair: { types: number; images: number; shown: number };
    /** 本机的导入捷径（开发机上找得到才给；正常用不到：目录随包、匹配在 Emaki 里自己做） */
    defaults: { folder: string | null; assignmentsPath: string | null; viewsPath: string | null; pairsPath: string | null };
    /** Emaki 自己的匹配：提取过姿势的插画里匹配过、还要匹配的（骨架、标签换过或姿势库升级了），正在跑或排队的「重新匹配姿势」 */
    match: { version: number; eligible: number; matched: number; pending: number; job: Job | null };
    /** 线稿：有线稿的姿势数（代表视角）、姿势总数、放线稿的文件夹（pose-covers/）；没有线稿的网页按骨架画小人 */
    covers: { found: number; total: number; dir: string };
  };
}

/** 姿势标签的低分：姿势名单里分数在 [0.17, 一般标签阈值) 的一般标签（达到阈值的照旧是普通标签） */
export interface PoseTagsStatus {
  /** 识别过的、计入统计的插画 */
  eligible: number;
  /** 其中还没收过低分姿势标签的（含模型不在本机的） */
  pending: number;
  /** 其中模型不在本机、这台电脑补不了的 */
  missingModel: number;
  /** 补完大约要多少秒（按每张约 0.5 秒估；没有要补的是 0） */
  estimateSeconds: number;
  /** 低分姿势标签的条数、有低分姿势标签的图 */
  lowTags: number;
  images: number;
  /** 用户开始了补充、还没补完（重启后接着补） */
  requested: boolean;
  /** 正在跑或排队的「补充姿势标签」任务 */
  job: Job | null;
  /** 本机有原型算好的低分文件（pose_tags_lowthr.npz）时给路径（pose.importTagsLow 的默认值），没有是 null */
  prototype: string | null;
}

/** POST /api/pose/tags/import 的结果 */
export interface PoseTagsImportResult {
  message: string;
  /** 写了的图、其中有低分姿势标签的图、写了几条 */
  imported: number;
  withTags: number;
  tags: number;
  /** 本图库里没有的图 */
  missing: number;
  /** 已经按现在的识别模型收过的（不覆盖） */
  skipped: number;
}

// ------------------------------------------------------------------ PoseWear 姿势库

/**
 * PoseWear 的三套单人姿势，加上「双人」：双人不按 pair60 的细名分，按互动类型合并（PAIR_TYPES），
 * id 是 pair_ + 代表线稿的编号（pair_P054）。
 */
export type PoseWearSet = 'full_single' | 'full_sexy' | 'upper80v2' | 'pair';
export const POSEWEAR_SINGLE_SETS = ['full_single', 'full_sexy', 'upper80v2'] as const;
export const POSEWEAR_SETS = [...POSEWEAR_SINGLE_SETS, 'pair'] as const;
export const POSEWEAR_SET_LABEL: Record<PoseWearSet, string> = { full_single: '全身', full_sexy: '全身·性感', upper80v2: '上半身', pair: '双人' };
/** 姿势 id：full_single_P001、pair_P054 这样 */
export const POSEWEAR_POSE_ID = /^(full_single|full_sexy|upper80v2|pair)_P\d{3}$/;

/** 双人里成人的那一类（分类名）：只在不模糊敏感图时显示 */
export const PAIR_ADULT_CATEGORY = '成人';

/**
 * 双人的互动类型：只收结果可靠的几类（tags_v1 看过），一类用一张 pair60 线稿当代表（rep），
 * members 是并进来的 pair60 姿势。P063 主要靠 reverse_upright_straddle 命中，归成人；P017 是正面缠腰，和坐在腿上分开。
 */
export const PAIR_TYPES: readonly { rep: string; name: string; members: readonly string[]; adult: boolean }[] = [
  { rep: 'P054', name: '公主抱', members: ['P054'], adult: false },
  { rep: 'P053', name: '从背后抱·站', members: ['P053'], adult: false },
  { rep: 'P044', name: '从背后抱·坐', members: ['P044'], adult: false },
  { rep: 'P009', name: '坐在腿上', members: ['P009', 'P010'], adult: false },
  { rep: 'P017', name: '缠腰相拥', members: ['P017'], adult: false },
  { rep: 'P051', name: '耳语', members: ['P051'], adult: false },
  { rep: 'P057', name: '相拥而眠', members: ['P057'], adult: false },
  { rep: 'P023', name: '面对面跨坐', members: ['P023'], adult: true },
  { rep: 'P018', name: '背对跨坐', members: ['P018'], adult: true },
  { rep: 'P063', name: '背靠开腿坐', members: ['P063'], adult: true },
  { rep: 'P041', name: '趴着抬臀', members: ['P041'], adult: true },
];

export interface PoseWearPose {
  id: string;
  set: PoseWearSet;
  /** P001 */
  number: string;
  name: string;
  category: string;
  /** 匹配到这个姿势、计入统计的图（双人里同一组差分只算一张） */
  count: number;
  /** 其中低置信的（lowtag+skel：标签弱、靠骨架）张数 */
  low: number;
  /** 成人（双人的成人一类）：模糊敏感图时不显示 */
  adult: boolean;
  /** 代表视角有线稿（用户导入的或放在 pose-covers/ 里的）；没有时 thumbUrl、imageUrl 是 404，按 skeletonUrl 的骨架画小人 */
  hasCover: boolean;
  /** 线稿小图（300×400 webp） */
  thumbUrl: string;
  /** 线稿大图（900×1200 webp，代表视角） */
  imageUrl: string;
  /** 代表视角的骨架（PoseWearSkeleton），画小人用 */
  skeletonUrl: string;
}

/** COCO 身体 17 点 + 脚 6 点里要连的线（画小人用） */
export const POSE_SKELETON_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 18], [15, 19], [16, 20], [16, 21], [16, 22],
];

/**
 * GET /api/pose/posewear-skeleton/:id（?view=）：姿势在一个视角线稿上的骨架。
 * 单人 persons 一个、双人两个；每个人 23 个点 [x, y, 置信度]，坐标按线稿长边归一（0–1），置信度不到 minConfidence 的点看不清、不画。
 * 没有骨架的姿势（线稿上没检测到人）persons 是空的
 */
export interface PoseWearSkeleton {
  poseId: string;
  /** 用的视角；没有骨架时是 null */
  view: string | null;
  /** 有骨架的视角 */
  views: string[];
  /** 线稿的宽、高（按长边归一，竖图 w < 1、h = 1） */
  w: number;
  h: number;
  persons: { points: [number, number, number][] }[];
  edges: readonly (readonly [number, number])[];
  minConfidence: number;
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
  /** 低置信（lowtag+skel） */
  low: boolean;
  /** 在这个姿势里的名次 */
  rank: number;
  /** 匹配上的视角（没有记视角时用代表视角） */
  view: string;
  /** 匹配上的那个视角的小图（没有记视角时用代表视角） */
  viewThumbUrl: string;
  /** 那个视角有线稿；没有时按 pose.skeletonUrl + ?view= 画小人 */
  viewHasCover: boolean;
}

/** GET /api/pose/posewear-match/:id：这张图的主要姿势和其他也匹配上的姿势（单人在前，双人在后） */
export interface PoseWearOfResponse {
  imageId: string;
  primary: PoseWearMatch | null;
  related: PoseWearMatch[];
}

/** 导入 PoseWear 姿势库的结果 */
export interface PoseWearImportResult extends PoseActionResult {
  /** 单人姿势数 */
  poses: number;
  /** 双人类型数（PoseWear 里找得到代表线稿的） */
  pairTypes: number;
  files: number;
}

/** GET /api/pose/posewear-low/:pose：这个姿势下低置信的图（网格上给它们做个小记号） */
export interface PoseWearLowResponse {
  ids: string[];
}

/** 导入姿势匹配结果的结果 */
export interface PoseWearAssignResult extends PoseActionResult {
  /** 单人：有匹配的图、图-姿势对、其中低置信的 */
  imported: number;
  memberships: number;
  low: number;
  /** 双人：有匹配的图、其中算作差分（不单独显示）的 */
  pairImages: number;
  pairVariants: number;
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
