/**
 * 后台任务种类的注册表（docs/core-architecture.md 第 7 节，附录 #34）：每种任务的名称、执行通道、优先级、显示名、能否取消……只登记在这一处。
 * 服务端的任务队列（通道、优先级）、任务链（哪些会记用户的暂停）、HTTP / MCP 的参数校验（能手动启动哪些），
 * 网页的任务名、进度动词、侧栏环里的字，都从这里取，不再各抄一份。
 *
 * 加一种任务：在这里登记一行（JobKind 跟着变），再在服务端 services/pipeline.ts 给它接上执行体。
 */

export interface JobKindSpec {
  /** 显示名（设置页的任务列表、首页横幅、命令面板、服务端的任务消息） */
  label: string;
  /** 执行通道：识别角色、画师主要吃显卡走 gpu；其余吃 CPU / 硬盘走 io。两条道同时跑，道内一次一个 */
  lane: 'io' | 'gpu';
  /** 道内的优先级：数字越小越先跑（新放进来的图要先扫描、出缩略图，别被一个多小时的识别堵住） */
  priority: number;
  /** 能不能取消（排队中、进行中都算） */
  cancellable: boolean;
  /** 能不能由用户 / 助手手动启动（POST /api/jobs、命令 jobs.start） */
  startable: boolean;
  /** 取消后记成用户的暂停：之后不再自动续跑，直到用户手动开始（持久化在 pending_work 的 pause:<任务>） */
  pausable: boolean;
  /** 会联网 */
  network: boolean;
  /** 进度条旁边的动词，比「进行中」更具体 */
  verb: string;
  /** 侧栏任务环里的字 */
  glyph: string;
}

export const JOB_KINDS = {
  scan: {
    label: '扫描图库',
    lane: 'io',
    priority: 0,
    cancellable: true,
    startable: true,
    pausable: false,
    network: false,
    verb: '扫描中',
    glyph: '扫',
  },
  thumbnail: {
    label: '生成缩略图',
    lane: 'io',
    priority: 1,
    cancellable: true,
    startable: true,
    pausable: false,
    network: false,
    verb: '生成中',
    glyph: '图',
  },
  dedupe: {
    label: '查找重复',
    lane: 'io',
    priority: 2,
    cancellable: true,
    startable: true,
    pausable: false,
    network: false,
    verb: '查找中',
    glyph: '重',
  },
  tag: {
    label: '识别角色',
    lane: 'gpu',
    priority: 3,
    cancellable: true,
    startable: true,
    pausable: true,
    network: false,
    verb: '识别中',
    glyph: '识',
  },
  'danbooru-sync': {
    label: '同步 Danbooru',
    lane: 'io',
    priority: 4,
    cancellable: true,
    startable: true,
    pausable: false,
    network: true,
    verb: '同步中',
    glyph: '同',
  },
  artists: {
    label: '识别画师',
    lane: 'gpu',
    priority: 5,
    cancellable: true,
    startable: true,
    pausable: true,
    network: false,
    verb: '识别中',
    glyph: '画',
  },
  'pixiv-tags': {
    label: '补充 Pixiv 角色',
    lane: 'io',
    priority: 6,
    cancellable: true,
    startable: true,
    pausable: true,
    network: true,
    verb: '查询中',
    glyph: 'P',
  },
} as const satisfies Record<string, JobKindSpec>;

/** artists：给还没识别过画师的图补跑 PixAI，只记画师（2026-10-04） */
export type JobKind = keyof typeof JOB_KINDS;

/** 全部任务种类（按登记顺序） */
export const JOB_KIND_LIST = Object.keys(JOB_KINDS) as JobKind[];

/** 能手动启动的任务（HTTP、MCP 的枚举由它生成） */
export const STARTABLE_JOB_KINDS = JOB_KIND_LIST.filter((k) => JOB_KINDS[k].startable) as [JobKind, ...JobKind[]];

/** 取消后记成用户暂停的任务 */
export type PausableJobKind = { [K in JobKind]: (typeof JOB_KINDS)[K]['pausable'] extends true ? K : never }[JobKind];
export const PAUSABLE_JOB_KINDS = JOB_KIND_LIST.filter((k) => JOB_KINDS[k].pausable) as PausableJobKind[];

export const jobSpec = (kind: JobKind): JobKindSpec => JOB_KINDS[kind];
