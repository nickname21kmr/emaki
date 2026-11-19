/**
 * 页面区块的注册表（docs/core-architecture.md 第 10 节，P5 为下一阶段的个性化页面留的接口）。
 *
 * 每个页面由带稳定 id 的区块组成；页面按这里的顺序渲染（PageBlocks），以后配置、插件按 id 引用、隐藏、调整顺序。
 * 每个区块登记它用到的公开查询（只能是服务端的 GET 接口，或者 SSE 事件）：区块拿数据只走这些，不在组件里藏业务规则
 * （test：apps/server/test/architecture/blocks.test.ts 核对每个查询都是真实存在的接口）。
 *
 * 这个文件只放数据，不 import React：服务端的测试也读它。
 * id 一旦发布就不要改（以后个人布局按 id 存）；新增区块加在对应页面里，删区块要连同布局迁移一起考虑。
 */

/** 区块用到的公开查询：GET 接口（路径用 Fastify 的写法）或 SSE 事件 */
export type BlockQuery = `GET /api/${string}` | `SSE ${string}`;

export interface BlockDef {
  /** 稳定 id：<页面>.<区块> */
  readonly id: string;
  /** 给人看的名字（以后的布局设置里显示） */
  readonly title: string;
  /** 页面里的哪一片（同一页不同容器里的区块分开排）；不写是 main */
  readonly region?: string;
  readonly queries: readonly BlockQuery[];
}

const block = <const Id extends string>(id: Id, title: string, queries: readonly BlockQuery[], region?: string) =>
  ({ id, title, queries, ...(region ? { region } : {}) }) as const;

export const PAGES = {
  home: {
    title: '首页',
    path: '/',
    blocks: [
      block('home.import', '首次导入', ['GET /api/summary', 'GET /api/images', 'SSE job']),
      block('home.stats', '统计条', ['GET /api/summary', 'GET /api/works']),
      block('home.daily', '今日一枚', ['GET /api/images', 'GET /api/images/:id', 'GET /api/characters/:id', 'GET /api/works']),
      block('home.triage', '待处理', [
        'GET /api/summary',
        'GET /api/unrecognized',
        'GET /api/duplicates',
        'GET /api/characters',
        'GET /api/settings',
        'SSE job',
      ]),
      block('home.recent', '最近 30 天在收', ['GET /api/summary', 'GET /api/characters/top']),
      block('home.latest', '最新入库', ['GET /api/summary', 'GET /api/images']),
      block('home.annex', '别册', ['GET /api/summary', 'GET /api/images']),
    ],
  },
  characters: {
    title: '角色总览',
    path: '/characters',
    blocks: [
      block('characters.top', '你最常看的', ['GET /api/characters/top', 'GET /api/works'], 'scope'),
      block('characters.recent', '最近 30 天在收', ['GET /api/characters/top'], 'overview'),
      block('characters.works', '作品', ['GET /api/works'], 'overview'),
      block('characters.list', '角色列表', ['GET /api/characters', 'GET /api/works'], 'list'),
    ],
  },
  character: {
    title: '角色扉页',
    path: '/characters/:id',
    blocks: [
      block('character.hero', '扉页', ['GET /api/characters/:id']),
      block('character.related', '常一起出现', ['GET /api/characters/:id']),
      block('character.collections', '收录于', ['GET /api/collections']),
      block('character.images', '全部插画', ['GET /api/images']),
    ],
  },
  work: {
    title: '作品页',
    path: '/works/:id',
    blocks: [
      block('work.hero', '作品', ['GET /api/works/:id']),
      block('work.characters', '角色', ['GET /api/characters']),
      block('work.collections', '收录于', ['GET /api/collections']),
      block('work.images', '全部插画', ['GET /api/images']),
    ],
  },
  collection: {
    title: '合集页（本子、画集）',
    path: '/collections/:id',
    blocks: [
      block('collection.head', '封面和版权页', ['GET /api/collections/:id']),
      block('collection.cast', '出场角色', ['GET /api/collections/:id']),
      block('collection.contents', '目录', ['GET /api/collections/:id', 'GET /api/images']),
    ],
  },
  group: {
    title: '合集页（组图）',
    path: '/collections/:id',
    blocks: [
      block('group.head', '封面和细线表', ['GET /api/collections/:id']),
      block('group.cast', '出场角色', ['GET /api/collections/:id']),
      block('group.contents', '全部图片', ['GET /api/collections/:id', 'GET /api/images']),
    ],
  },
} as const satisfies Record<string, { title: string; path: string; blocks: readonly BlockDef[] }>;

export type PageId = keyof typeof PAGES;
/** 某一页的区块 id */
export type BlockId<P extends PageId> = (typeof PAGES)[P]['blocks'][number]['id'];

/** 这一页（某一片）按注册表顺序的区块 */
export function blocksOf<P extends PageId>(page: P, region = 'main'): BlockDef[] {
  return (PAGES[page].blocks as readonly BlockDef[]).filter((b) => (b.region ?? 'main') === region);
}

/** 全部区块（测试、以后的布局设置用） */
export const ALL_BLOCKS: readonly BlockDef[] = Object.values(PAGES).flatMap((p) => p.blocks as readonly BlockDef[]);
