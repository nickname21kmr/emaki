/**
 * 搜索用的文本归一化，前后端共用，保证「未花 / ミカ / mika / Mika_(Blue_Archive)」都能搜到同一个角色。
 */

/** 全角转半角、转小写、去掉空白和下划线、去掉括号里的作品后缀。 */
export function normalizeForSearch(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '') // mika_(blue_archive) → mika_
    .replace(/[\s_\-·・]+/g, '');
}

/** 片假名 → 平假名，这样「ミカ」和「みか」算同一个。 */
export function katakanaToHiragana(input: string): string {
  return input.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function searchKey(input: string): string {
  return katakanaToHiragana(normalizeForSearch(input));
}

/** 任一候选文本包含查询即算命中。空查询永远命中。 */
export function matchesQuery(query: string, candidates: readonly (string | null | undefined)[]): boolean {
  const q = searchKey(query);
  if (!q) return true;
  return candidates.some((c) => c != null && searchKey(c).includes(q));
}
