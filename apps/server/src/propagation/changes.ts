/**
 * 变化（docs/core-architecture.md 第 5.1 节）：主人模块写完一笔，在当前事务里声明「改了什么」，
 * 连带处理由订阅这条变化的反应完成（registry.ts）。
 *
 * 每条变化都带 ids（涉及的图片 id，可以为空）；按图片的变化 ids 为空时直接丢掉（什么都没改）。
 * 细节字段只放反应真的要用的东西，不放整行快照。
 */
import type { DomainChange } from '@emaki/shared';

/** 移动的来由：扫描发现 / 应用内移动 / 整理到子文件夹 / 撤回移动 / 图库文件夹合并或接管 */
export type MoveReason = 'scan' | 'move' | 'organize' | 'revertMove' | 'root';
/** 证据的来源：识别模型、Pixiv 投稿标签、识别画师；以后的插件来源记成 plugin:<id> */
export type EvidenceProvider = 'tagger' | 'pixiv' | 'artists' | `plugin:${string}`;
/** 文件内容变化的来由（D1）：扫描发现 / 用户替换。只记录在案，处理完全相同 */
export type FileChangeReason = 'scan' | 'replace';
/**
 * 读文件头时顺便知道的事实（帧数、相机）：图库与文件模块读文件时拿到，交给分析模块写（帧数、相机是分析的列）。
 * 某一项是 undefined 表示这次没读到，分析模块不动它
 */
export interface ProbeFacts {
  id: number;
  frames?: number | null;
  camera?: string | null;
}
/** 一张图的文件内容变化：新旧 sha256 */
export interface FileVersion {
  id: number;
  before: string;
  after: string;
}

type ImageChange<T extends string, X = unknown> = { type: T; ids: number[] } & X;

export type Change =
  // 图库与文件
  /** 新入库；probes：读文件头时拿到的帧数、相机（分析模块按它判类型） */
  | ImageChange<'image.added', { probes?: ProbeFacts[] }>
  | ImageChange<'image.gone'>
  | ImageChange<'image.returned'>
  /**
   * 同一 id 的文件内容变了（D1）：扫描发现外部改了文件、用户替换文件都发这一条，处理完全相同（reason 只记录在案）。
   * files 是每张图的新旧 sha；probes 同 image.added
   */
  | ImageChange<'image.fileChanged', { reason: FileChangeReason; files: FileVersion[]; probes?: ProbeFacts[] }>
  | ImageChange<'image.moved', { reason: MoveReason }>
  | ImageChange<'image.trashed'>
  | ImageChange<'image.restored'>
  /** 图库文件夹启用、停用、移除、加回；ids 是已知受影响的图（可以为空，按文件夹算） */
  | ImageChange<'root.visibilityChanged', { rootIds: number[] }>
  /** 按漫画导入的设置变了（整个文件夹或里面的子文件夹）；ids 是这些文件夹里的图（可以为空：只知道有图和设置对不上） */
  | ImageChange<'root.modeChanged', { rootIds: number[] }>
  // 分析、证据
  /** 最终类型变了（自动重判、手动修改都算） */
  | ImageChange<'image.kindChanged'>
  /** 是否动图变了（D5：分析模块按帧数、格式派生，和类型是两个维度；读到帧数、换了文件时才会变） */
  | ImageChange<'image.animatedChanged'>
  /** 最终来源变了 */
  | ImageChange<'image.sourceChanged'>
  | ImageChange<'evidence.changed', { provider: EvidenceProvider }>
  // 归类
  | ImageChange<'curation.charactersChanged'>
  | ImageChange<'curation.originalChanged'>
  /**
   * 自动决定（reevaluateAuto）改了原创标记。和 curation.originalChanged 是同一个事实，分开声明只是为了
   * reevaluateAuto 订阅「原创变化」时不订阅到自己的输出（反应之间不能有环）；关心原创的反应两个都订阅
   */
  | ImageChange<'curation.autoOriginalChanged'>
  /** 请求按当前规则重新评估这些图的自动决定（「按当前阈值补采纳」命令） */
  | ImageChange<'curation.autoRequested'>
  | ImageChange<'curation.shelvedChanged'>
  | ImageChange<'curation.ratingChanged'>
  | ImageChange<'curation.favoriteChanged'>
  | ImageChange<'curation.artistsChanged'>
  | ImageChange<'curation.vetoesChanged'>
  // 编目：characterIds 是涉及的角色；ids 是已知受影响的图（可以为空）
  | ImageChange<'catalog.characterChanged', { characterIds: number[] }>
  /**
   * 进了角色页、清掉「+N」：只改了角色的「上次看过」时间。和 catalog.characterChanged 对外是同一个名字，分开声明是因为它
   * 改不到名字、别名、绑定：不用重算「自建角色能对上 Danbooru」，缓存也只动这个角色的「+N」（cacheScope.ts）
   */
  | ImageChange<'catalog.characterSeen', { characterIds: number[] }>
  | ImageChange<'catalog.merged', { characterIds: number[] }>
  | ImageChange<'catalog.bindingChanged', { characterIds: number[] }>
  // 可见性
  /** 排除规则或排除例外（用户的决定）变了：这些图要重新判定 */
  | ImageChange<'visibility.rulesChanged'>
  /** 排除结果变了（派生）：新排除的和放出来的 */
  | ImageChange<'visibility.changed', { excluded: number[]; released: number[] }>
  // 合集：collectionIds 是成员或页序要重排的合集
  | ImageChange<'collections.changed', { collectionIds: number[] }>
  // 查重
  | ImageChange<'duplicates.changed'>
  // 设置
  | ImageChange<'settings.changed', { sections: string[] }>
  /** 这些图的姿势数据变了（提取、导入；姿势模块写） */
  | ImageChange<'pose.changed'>
  /** 启动：规则版本可能变了，派生数据整体对一遍（全量重算合集、排除结果） */
  | ImageChange<'library.opened'>;

export type ChangeType = Change['type'];
export type ChangeOf<T extends ChangeType> = Extract<Change, { type: T }>;

/** 没有图片 id 就等于什么都没改的变化；其余（文件夹、编目、设置、查重、启动）ids 为空也照样处理 */
const IMAGE_SCOPED = new Set<ChangeType>([
  'image.added',
  'image.gone',
  'image.returned',
  'image.fileChanged',
  'image.moved',
  'image.trashed',
  'image.restored',
  'image.kindChanged',
  'image.animatedChanged',
  'image.sourceChanged',
  'evidence.changed',
  'curation.charactersChanged',
  'curation.originalChanged',
  'curation.autoOriginalChanged',
  'curation.autoRequested',
  'curation.shelvedChanged',
  'curation.ratingChanged',
  'curation.favoriteChanged',
  'curation.artistsChanged',
  'curation.vetoesChanged',
  'visibility.rulesChanged',
  'visibility.changed',
  'pose.changed',
]);

/** 这条变化有没有内容（按图片的变化 ids 为空时没有） */
export const isEmptyChange = (c: Change): boolean => IMAGE_SCOPED.has(c.type) && !c.ids.length;

/** 所有变化类型（反应订阅「任何变化」时用） */
export const ALL_CHANGES: readonly ChangeType[] = [
  ...IMAGE_SCOPED,
  'root.visibilityChanged',
  'root.modeChanged',
  'catalog.characterChanged',
  'catalog.characterSeen',
  'catalog.merged',
  'catalog.bindingChanged',
  'collections.changed',
  'duplicates.changed',
  'settings.changed',
  'library.opened',
];

/**
 * 对外事件里的变化类型（packages/shared 的 DOMAIN_CHANGES，附录 #36）：内部的变化 → 公开的名字，null 不公开。
 * 写成完整的映射，加了新的变化类型这里不补就过不了类型检查
 */
export const PUBLIC_CHANGE: Record<ChangeType, DomainChange | null> = {
  'image.added': 'image.added',
  'image.gone': 'image.gone',
  'image.returned': 'image.returned',
  'image.fileChanged': 'image.fileChanged',
  'image.moved': 'image.moved',
  'image.trashed': 'image.trashed',
  'image.restored': 'image.restored',
  'root.visibilityChanged': 'root.visibilityChanged',
  'root.modeChanged': 'root.modeChanged',
  'image.kindChanged': 'image.kindChanged',
  'image.animatedChanged': 'image.animatedChanged',
  'image.sourceChanged': 'image.sourceChanged',
  'evidence.changed': 'evidence.changed',
  'curation.charactersChanged': 'curation.charactersChanged',
  'curation.originalChanged': 'curation.originalChanged',
  // 自动标原创对外就是原创变了；补采纳的「请求重新评估」是内部的，评估的结果会以角色变化出现
  'curation.autoOriginalChanged': 'curation.originalChanged',
  'curation.autoRequested': null,
  'curation.shelvedChanged': 'curation.shelvedChanged',
  'curation.ratingChanged': 'curation.ratingChanged',
  'curation.favoriteChanged': 'curation.favoriteChanged',
  'curation.artistsChanged': 'curation.artistsChanged',
  'curation.vetoesChanged': 'curation.vetoesChanged',
  'catalog.characterChanged': 'catalog.characterChanged',
  // 「看过了」对外就是角色变了（前端按它刷新角色的查询）
  'catalog.characterSeen': 'catalog.characterChanged',
  'catalog.merged': 'catalog.merged',
  'catalog.bindingChanged': 'catalog.bindingChanged',
  'visibility.rulesChanged': 'visibility.rulesChanged',
  'visibility.changed': 'visibility.changed',
  'collections.changed': 'collections.changed',
  'duplicates.changed': 'duplicates.changed',
  'settings.changed': 'settings.changed',
  'library.opened': 'library.opened',
  'pose.changed': 'pose.changed',
};

/** 一组变化对外的类型（去重，按出现顺序） */
export function publicChanges(list: readonly Change[]): DomainChange[] {
  const out = new Set<DomainChange>();
  for (const c of list) {
    const p = PUBLIC_CHANGE[c.type];
    if (p) out.add(p);
  }
  return [...out];
}

/** 一个事务里声明的变化（按声明顺序） */
export class ChangeSet {
  readonly list: Change[];

  constructor(list: Change[] = []) {
    this.list = list;
  }

  get size(): number {
    return this.list.length;
  }

  /** 加一条；返回加了没有（空的按图片变化不加） */
  add(c: Change): boolean {
    if (isEmptyChange(c)) return false;
    this.list.push(c);
    return true;
  }

  has(...types: ChangeType[]): boolean {
    return this.list.some((c) => types.includes(c.type));
  }

  of<T extends ChangeType>(type: T): ChangeOf<T>[] {
    return this.list.filter((c): c is ChangeOf<T> => c.type === type);
  }

  /** 这些类型的变化涉及的图片 id（去重，按出现顺序）；不给类型 = 全部 */
  ids(...types: ChangeType[]): number[] {
    const out = new Set<number>();
    for (const c of this.list) if (!types.length || types.includes(c.type)) for (const id of c.ids) out.add(id);
    return [...out];
  }

  /** 编目变化涉及的角色 id */
  characterIds(): number[] {
    const out = new Set<number>();
    for (const c of this.list) if ('characterIds' in c) for (const id of c.characterIds) out.add(id);
    return [...out];
  }
}
