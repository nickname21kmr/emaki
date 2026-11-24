/**
 * 界面上「几样东西按顺序排在一处」的地方（docs/plugins.md 9.2 的贡献点，E3）：页头的操作（page.action）、
 * 看图器的顶栏按钮（lightbox.toolbar）和信息栏（lightbox.panel）、菜单里的项（menu.item）。
 *
 * 和区块（registry.ts）一样，这个文件只放数据、不 import React：每处登记它的条目（稳定 id、给人看的名字），
 * 页面按这里的顺序画（Slot.tsx），每个条目怎么画由页面闭包进来。所以：
 * - 内置的入口都在这里有名有姓：以后插件往这些地方加东西、个人布局隐藏或换顺序、第 3 层按名字打补丁，都按 id 来；
 * - 停用的插件拥有的条目不画（拥有关系登记在 @emaki/shared 的 BUILTIN_PLUGINS，跨插件的才需要写，比如「角色」页头上的「作品页」属于作品）；
 * - 页面少画、多画一个条目，类型检查就不过（渲染函数的表按这里的 id 定型）。
 *
 * id 一旦发布就不要改：<地方>.<条目>。
 */

export interface SlotEntry {
  /** 稳定 id */
  readonly id: string;
  /** 给人看的名字（以后的布局设置、「谁改了哪里」里显示） */
  readonly title: string;
}

export interface SlotDef {
  /** 哪个贡献点（插件清单里的键） */
  readonly point: SlotPoint;
  /** 这一处叫什么 */
  readonly title: string;
  readonly entries: readonly SlotEntry[];
}

export const SLOT_POINTS = ['page.action@1', 'menu.item@1', 'lightbox.toolbar@1', 'lightbox.panel@1'] as const;
export type SlotPoint = (typeof SLOT_POINTS)[number];

const e = <const Id extends string>(id: Id, title: string) => ({ id, title }) as const;

export const SLOTS = {
  // ---------------------------------------------------------------- 看图器
  'lightbox.toolbar': {
    point: 'lightbox.toolbar@1',
    title: '看图器顶栏',
    entries: [
      e('lightbox.slideshow', '暂停 / 继续放映'),
      e('lightbox.kind', '归入…'),
      e('lightbox.assistant', '问 AI 助手'),
      e('lightbox.info', '显示 / 收起信息'),
      e('lightbox.close', '关闭'),
    ],
  },
  'lightbox.actions': {
    point: 'lightbox.panel@1',
    title: '看图器信息栏的操作',
    entries: [
      e('lightbox.favorite', '收藏'),
      e('lightbox.original', '原创'),
      e('lightbox.reveal', '在文件夹中显示'),
      e('lightbox.exclude', '排除'),
      e('lightbox.trash', '移到回收站'),
    ],
  },
  'lightbox.panel': {
    point: 'lightbox.panel@1',
    title: '看图器信息栏',
    entries: [
      e('lightbox.characters', '角色'),
      e('lightbox.artists', '画师'),
      e('lightbox.rating', '分级'),
      e('lightbox.contentKind', '类型'),
      e('lightbox.details', '信息'),
      e('lightbox.tags', '标签'),
    ],
  },

  // ---------------------------------------------------------------- 页头的操作（page.action）
  'page.gallery': {
    point: 'page.action@1',
    title: '图库的页头',
    entries: [e('gallery.artist', '画师'), e('gallery.sendToComputer', '发到电脑'), e('gallery.select', '多选')],
  },
  'page.characters': {
    point: 'page.action@1',
    title: '角色的页头',
    entries: [e('characters.customMatch', '自定义匹配'), e('characters.new', '新建角色')],
  },
  'page.characters.work': {
    point: 'page.action@1',
    title: '角色总览里一部作品的标题',
    entries: [e('characters.workPage', '作品页')],
  },
  'page.collections': {
    point: 'page.action@1',
    title: '合集的页头',
    entries: [e('collections.reviewAll', '整套标为已整理'), e('collections.linkCharacter', '整套关联角色')],
  },
  'page.unrecognized': {
    point: 'page.action@1',
    title: '未识别的页头',
    entries: [
      e('unrecognized.pixivTags', 'Pixiv 标签'),
      e('unrecognized.promote', '采纳建议'),
      e('unrecognized.retag', '重新识别'),
      e('unrecognized.runTagger', '识别新图'),
    ],
  },
  'page.duplicates': { point: 'page.action@1', title: '重复的页头', entries: [e('duplicates.rescan', '重新查重')] },
  'page.excluded': { point: 'page.action@1', title: '已排除的页头', entries: [e('excluded.addRule', '添加规则')] },
  'page.annex': { point: 'page.action@1', title: '别册的页头', entries: [e('annex.comicView', '成册 / 散页')] },
  'page.plugins': { point: 'page.action@1', title: '插件的页头', entries: [e('plugins.newOverride', '新建覆盖'), e('plugins.install', '安装')] },
  'page.plugin': {
    point: 'page.action@1',
    title: '插件详情的页头',
    entries: [e('plugin.rename', '改名'), e('plugin.update', '检查更新 / 重新读取'), e('plugin.remove', '删除 / 卸载')],
  },
  'page.collection': { point: 'page.action@1', title: '一本合集的页头', entries: [e('collection.read', '继续读 / 从头读'), e('collection.more', '更多')] },
  'page.group': {
    point: 'page.action@1',
    title: '一组组图的页头',
    entries: [e('group.add', '添加图片'), e('group.read', '继续读 / 从头读'), e('group.more', '更多')],
  },

  'page.character': {
    point: 'page.action@1',
    title: '角色扉页右上角',
    entries: [e('character.cover', '换封面'), e('character.pin', '置顶'), e('character.edit', '编辑角色'), e('character.more', '更多')],
  },

  // ---------------------------------------------------------------- 菜单里的项（menu.item）
  'menu.character': {
    point: 'menu.item@1',
    title: '角色扉页的「更多」',
    entries: [
      e('character.merge', '合并到其他角色'),
      e('character.move', '移动到文件夹'),
      e('character.restoreCover', '恢复自动封面'),
      e('character.exclude', '排除 / 恢复这个角色'),
    ],
  },
  'menu.collection': {
    point: 'menu.item@1',
    title: '一本合集的「更多」',
    entries: [
      e('collection.rename', '改名'),
      e('collection.kind', '类型'),
      e('collection.restoreKind', '恢复自动判断类型'),
      e('collection.addImages', '添加图片'),
      e('collection.pageOrder', '页序'),
      e('collection.series', '归入系列'),
      e('collection.reveal', '在资源管理器中显示'),
      e('collection.dismiss', '不成册 / 解散'),
    ],
  },
  'menu.group': {
    point: 'menu.item@1',
    title: '一组组图的「更多」',
    entries: [
      e('group.rename', '改名'),
      e('group.kind', '类型'),
      e('group.organize', '整理到子文件夹'),
      e('group.reveal', '在资源管理器中显示'),
      e('group.dismiss', '解散组图'),
    ],
  },
} as const satisfies Record<string, SlotDef>;

export type SlotId = keyof typeof SLOTS;
/** 某一处的条目 id */
export type SlotEntryId<S extends SlotId> = (typeof SLOTS)[S]['entries'][number]['id'];

/** 全部条目（测试、以后的布局设置用） */
export const ALL_SLOT_ENTRIES: readonly (SlotEntry & { slot: SlotId; point: SlotPoint })[] = (Object.entries(SLOTS) as [SlotId, SlotDef][]).flatMap(
  ([slot, d]) => d.entries.map((x) => ({ ...x, slot, point: d.point })),
);
