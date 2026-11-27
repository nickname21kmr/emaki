// 改内部（第 3 层，docs/plugins.md 第 7 节）：在 Emaki 自己的进程里加载。
// 改的是「排名的张数怎么数」（term:count.unit）：它返回一张图的计数键的 SQL，键相同的算一张。
// 内置是图片 id（每张各算一张）；这里把组图（同一个 Pixiv 投稿的几张，合集的 kind = 'group'）里的图都换成「负的合集 id」，
// 一个投稿就只算一张。本子、画集不是组图，照旧一页算一张。

/** 组图：同一个投稿的几张（合集还在、没被你拆开） */
const GROUPS = "SELECT id FROM collections WHERE kind = 'group' AND state = 'active'";

export function activate(internal) {
  internal.patch('term:count.unit', {
    around: (next, alias = 'i') => `CASE WHEN ${alias}.collection_id IN (${GROUPS}) THEN -${alias}.collection_id ELSE ${next(alias)} END`,
  });
}
