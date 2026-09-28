/**
 * 画面质量分（T25.5，从 datasource/sqlite/derived.ts 原样移来）：自动封面排序、未识别的 art_score 共用。
 */

/** fav：收藏；cs：角色置信度；others：同图还有几个别的角色 */
export interface QualityInput {
  w: number;
  h: number;
  fileName: string;
  fav: number;
  cs: number;
  others: number;
}

/**
 * 封面候选的画面标签权重：[分组, 权重]。同组负分取最低、正分取最高，各组相加，乘上标签置信度。
 * 聊天记录、界面截图、文字图、漫画格、黑白、多人、无人、照片都要往后排（用户：封面尽量好看高质量）。
 */
export const COVER_TAG_WEIGHTS: Record<string, [string, number]> = {
  chat_log: ['ui', -80], fake_screenshot: ['ui', -60], user_interface: ['ui', -60], 'heads-up_display': ['ui', -50],
  fake_phone_screenshot: ['ui', -60], twitter_username: ['ui', -20],
  comic: ['panel', -35], '4koma': ['panel', -35], multiple_views: ['panel', -15], reference_sheet: ['panel', -20],
  monochrome: ['mono', -25], greyscale: ['mono', -25], lineart: ['mono', -20], sketch: ['mono', -15],
  text_focus: ['text', -30], speech_bubble: ['text', -15], chinese_text: ['text', -12], translated: ['text', -12],
  english_text: ['text', -10], japanese_text: ['text', -10],
  '3girls': ['crowd', -12], multiple_girls: ['crowd', -10], multiple_boys: ['crowd', -10], '2girls': ['crowd', -8],
  no_humans: ['nohum', -40],
  'photo_(medium)': ['photo', -25], realistic: ['photo', -20], cosplay: ['photo', -15],
  solo: ['solo', 12], looking_at_viewer: ['gaze', 4], upper_body: ['frame', 3], portrait: ['frame', 3],
};
const SCREENSHOT_NAME = /^(screenshot|screen[ _]?shot|screencap|snipaste|截屏|截图|屏幕截图|qq截图|微信截图)/i;
const PHONE_WIDTHS = new Set([720, 750, 828, 1080, 1125, 1170, 1179, 1242, 1284, 1290, 1440]);

const UNFIT_TAGS = new Set(['chat_log', 'fake_screenshot', 'user_interface', 'heads-up_display', 'fake_phone_screenshot', 'text_focus']);

/** 不能当封面的图：带截图 / 聊天 / 界面 / 文字为主的标签（≥ 0.5），或文件名就是截图 */
export function isUnfitCover(fileName: string, tags: [string, number][]): boolean {
  return SCREENSHOT_NAME.test(fileName) || tags.some(([name, score]) => score >= 0.5 && UNFIT_TAGS.has(name));
}

export function coverQuality(c: QualityInput, tags: [string, number][]): number {
  const neg = new Map<string, number>();
  const pos = new Map<string, number>();
  for (const [name, score] of tags) {
    const wt = COVER_TAG_WEIGHTS[name];
    if (!wt) continue;
    const v = wt[1] * score;
    if (v < 0) neg.set(wt[0], Math.min(neg.get(wt[0]) ?? 0, v));
    else pos.set(wt[0], Math.max(pos.get(wt[0]) ?? 0, v));
  }
  let q = 25 * c.cs - Math.min(8 * c.others, 24) + (c.fav ? 15 : 0);
  for (const v of neg.values()) q += v;
  for (const v of pos.values()) q += v;
  const r = c.w / Math.max(c.h, 1);
  q += r >= 0.6 && r <= 0.85 ? 10 : r >= 0.5 && r <= 1 ? 5 : r < 0.5 ? -6 : r <= 1.25 ? 0 : -10;
  const short = Math.min(c.w, c.h);
  q += short >= 1200 ? 8 : short >= 800 ? 5 : short >= 500 ? 0 : -15;
  // 没打标签也能认出来的截图：文件名、手机屏幕尺寸
  if (SCREENSHOT_NAME.test(c.fileName)) q -= 60;
  if (PHONE_WIDTHS.has(Math.min(c.w, c.h)) && Math.max(c.w, c.h) / Math.min(c.w, c.h) >= 1.9) q -= 30;
  return q;
}
