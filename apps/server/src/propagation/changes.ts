/**
 * 变化（docs/core-architecture.md 第 5.1 节）：主人模块写完一笔，在当前事务里声明「改了什么」，
 * 连带处理由订阅这条变化的反应完成（registry.ts）。
 *
 * 每条变化都带 ids（涉及的图片 id，可以为空）；按图片的变化 ids 为空时直接丢掉（什么都没改）。
 * 细节字段只放反应真的要用的东西，不放整行快照。
 */

/** 移动的来由：扫描发现 / 应用内移动 / 整理到子文件夹 / 撤回移动 / 图库文件夹合并或接管 */
export type MoveReason = 'scan' | 'move' | 'organize' | 'revertMove' | 'root';
/** 证据的来源：识别模型、Pixiv 投稿标签、识别画师；以后的插件来源记成 plugin:<id> */
export type EvidenceProvider = 'tagger' | 'pixiv' | 'artists' | `plugin:${string}`;

type ImageChange<T extends string, X = unknown> = { type: T; ids: number[] } & X;

export type Change =
  // 图库与文件
  | ImageChange<'image.added'>
  | ImageChange<'image.gone'>
  | ImageChange<'image.returned'>
  | ImageChange<'image.fileChanged', { reason: 'scan' | 'replace' }>
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
]);

/** 这条变化有没有内容（按图片的变化 ids 为空时没有） */
export const isEmptyChange = (c: Change): boolean => IMAGE_SCOPED.has(c.type) && !c.ids.length;

/** 所有变化类型（反应订阅「任何变化」时用） */
export const ALL_CHANGES: readonly ChangeType[] = [
  ...IMAGE_SCOPED,
  'root.visibilityChanged',
  'root.modeChanged',
  'catalog.characterChanged',
  'catalog.merged',
  'catalog.bindingChanged',
  'collections.changed',
  'duplicates.changed',
  'settings.changed',
  'library.opened',
];

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
