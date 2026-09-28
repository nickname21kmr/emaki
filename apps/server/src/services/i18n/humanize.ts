/**
 * Danbooru 标签 → 人能读的名字（没有中文名时的兜底）。T12 的 Localizer 会优先用词库。
 */

/**
 * 只去掉最后一个 `_(...)`；剩下的 `_(xxx)` 变成 ` (Xxx)`；下划线变空格；每个词首字母大写。
 * mika_(blue_archive) → Mika；hatsune_miku → Hatsune Miku；mika_(swimsuit)_(blue_archive) → Mika (Swimsuit)
 */
export function humanizeCharacterTag(tag: string): string {
  const stripped = tag.replace(/_\([^()]*\)$/, '');
  return stripped
    .replace(/_\(([^()]*)\)/g, ' ($1)')
    .split('_')
    .filter(Boolean)
    .join(' ')
    .replace(/(^|[\s(])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/**
 * 只去掉结尾的 `_(series)`，其他括号保留成 ` (Xxx)`；`/` `:` `-` `(` 后面的字母也大写。
 * fate_(series) → Fate；fate/grand_order → Fate/Grand Order；honkai:_star_rail → Honkai: Star Rail；pokemon_(anime) → Pokemon (Anime)
 */
export function humanizeCopyrightTag(tag: string): string {
  return tag
    .replace(/_\(series\)$/, '')
    .replace(/_/g, ' ')
    .replace(/(^|[\s/:(-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/** 只去掉结尾最后一个全角 / 半角括号：圣园未花（泳装）（蔚蓝档案）→ 圣园未花（泳装）；去完为空则原样返回 */
export function stripZhQualifier(zh: string): string {
  const out = zh.replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim();
  return out || zh;
}

/** wiki other_name 清理：'_' → 空格、去掉结尾 (…) / （…）、trim；长度 > 40 或含 http 返回 null */
export function cleanOtherName(s: string): string | null {
  const out = s
    .replace(/_/g, ' ')
    .replace(/\s*[（(][^（）()]*[）)]\s*$/, '')
    .trim();
  if (!out || out.length > 40 || /http/i.test(out)) return null;
  return out;
}
