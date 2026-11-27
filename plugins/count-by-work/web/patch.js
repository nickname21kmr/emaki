// 改网页（第 3 层，docs/plugins.md 第 7 节）：在 Emaki 的网页里加载。
// 改的是「排名的张数后面写的字」（fn:count.unit）：服务端那一半（server/patch.mjs）把组图算成一件以后，
// 角色卡、作品、画师这些地方的数后面写「件」，数和字对得上。图库的总数这类不是按投稿数的，照旧写「张」。
export function activate(internal) {
  internal.patch('fn:count.unit', { after: () => '件' });
}
