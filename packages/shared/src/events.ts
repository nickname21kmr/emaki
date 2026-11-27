/**
 * 对外事件（GET /api/events，SSE；docs/core-architecture.md 第 9 节，附录 #36）。
 *
 * 只给领域变化的公开部分：变了哪一类事实（DOMAIN_CHANGES）、谁做的、哪个命令，不带服务端内部的细节（快照、文件头、sha）。
 * 可补发的事件（changed、command、auto-change）带递增的 id，SSE 的 id 行是 `<启动 id>.<序号>`；
 * 断线重连时浏览器带着 Last-Event-ID 回来，服务端补发漏掉的；补不上（重启过、漏得太多）先推一条 resync，前端整体刷新。
 */
import type { AutoChangeEvent, LibraryChangedReason, PluginNoticeEvent } from './api.ts';
import type { ID } from './domain.ts';

/**
 * 公开的变化类型：和服务端 propagation/changes.ts 的变化同名（第 5.1 节的表）。
 * 服务端内部用的请求（curation.autoRequested）不公开；自动标原创（curation.autoOriginalChanged）对外就是原创变了
 */
export const DOMAIN_CHANGES = [
  'image.added',
  'image.gone',
  'image.returned',
  'image.fileChanged',
  'image.moved',
  'image.trashed',
  'image.restored',
  'root.visibilityChanged',
  'root.modeChanged',
  'image.kindChanged',
  'image.animatedChanged',
  'image.sourceChanged',
  'evidence.changed',
  'curation.charactersChanged',
  'curation.originalChanged',
  'curation.shelvedChanged',
  'curation.ratingChanged',
  'curation.favoriteChanged',
  'curation.artistsChanged',
  'curation.vetoesChanged',
  'catalog.characterChanged',
  'catalog.merged',
  'catalog.bindingChanged',
  'visibility.rulesChanged',
  'visibility.changed',
  'collections.changed',
  'duplicates.changed',
  'settings.changed',
  'pose.changed',
  'plugins.changed',
  'library.opened',
] as const;
export type DomainChange = (typeof DOMAIN_CHANGES)[number];

/** 对外的 actor：用户、AI 助手、后台任务（job:<种类>）、启动修补（system:<步骤>）、以后的插件（plugin:<id>） */
export type PublicActor = string;

/** 一次写入（一个事务）提交之后：变了哪些事实。后台任务的按任务种类节流（几秒一条，合并类型） */
export interface ChangedEvent {
  type: 'changed';
  /** 递增的事件 id（这次启动内） */
  id: number;
  /** 变了的事实类型（去重） */
  changes: DomainChange[];
  /** 'mutation'：用户或助手的操作；任务种类：那个后台任务写的；'system'：启动修补 */
  reason: LibraryChangedReason;
  actor: PublicActor;
  /** 命令层执行的命令（后台任务、启动修补没有） */
  command?: string;
}

/**
 * 用户或助手执行完一个写命令。AI 助手做的、可撤销的修改，网页据此放进撤销栈（按 boot 认领，后端重启过的不要）
 */
export interface CommandEvent {
  type: 'command';
  id: number;
  /** 命令名（例如 curation.link） */
  name: string;
  actor: PublicActor;
  /** 给 toast 的那句话 */
  message: string;
  undoToken: string | null;
  /** 撤销栈里怎么记：token 可撤销；barrier 不可撤销的命令（撤销屏障）；none 不占位置 */
  undo: UndoKind;
  /** 这次启动的 id（撤销令牌只在这次启动内有效） */
  boot: string;
  /** 涉及的图片（撤销后指给用户看，最多 200 张） */
  imageIds?: ID[];
}

/** 写命令的结果在撤销栈里怎么记（命令注册表里「是否可撤销」决定，前端不再自己判断） */
export type UndoKind = 'token' | 'barrier' | 'none';

/** 补不上了：前端整体刷新 */
export interface ResyncEvent {
  type: 'resync';
  reason: 'restarted' | 'gap';
}

/** 连上（包括重连、补发完）时的第一条：这次启动的 id 和现在最后一条事件的 id（前端手动重连时从这里接着要） */
export interface HelloEvent {
  type: 'hello';
  boot: string;
  lastId: number;
}

/** 可补发的事件（带 id） */
export type ReplayableEvent = Omit<ChangedEvent, 'id'> | Omit<CommandEvent, 'id'> | Omit<AutoChangeEvent, 'id'> | Omit<PluginNoticeEvent, 'id'>;
