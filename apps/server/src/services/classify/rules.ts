/**
 * 图片内容类型分类器（T27）：纯函数，不做 IO。
 *
 * 规则与阈值照 docs/design/m5/classify-rules.reference.cjs 移植（2026-09-27 在用户真实图库上抽样验证过），
 * 按 TASKS.md T27 第 1a 条修改：删掉「小图文字 → 表情」、GIF 判 animated、camera 按非空字符串判断、来源映射到 ContentKindSource。
 * 判定顺序：先命中先返回——文件名 / 文件夹 / 相机（强信号）→ 格式 → 识别标签 → 手机屏幕尺寸（弱信号）→ 插画。
 *
 * 注意：image_tags 只存 ≥ generalThreshold（默认 0.35）的分数，所以「no_humans < 0.3」实际等于「没有入库」。
 * 改规则（包括 theme.ts 的主题规则）要把 CLASSIFIER_VERSION 加一，启动时会按新规则重算全库（手动改过的类型保留）。
 */
import type { ContentKind, ContentKindSource, ImageFormat } from '@emaki/shared';

export const CLASSIFIER_VERSION = 1;

export interface ClassifyInput {
  fileName: string;
  relPath: string;
  width: number;
  height: number;
  format: ImageFormat;
  /** 'HUAWEI EML-AL00' = 相机拍摄；'' = 读过但不是；null = 还没读 */
  camera: string | null;
  /** general 标签分数；null = 还没打标签 */
  tags: ReadonlyMap<string, number> | null;
  /** 所在图库文件夹是「按漫画导入」的：每张都是漫画页 */
  comicRoot?: boolean;
}

export interface ClassifyResult {
  kind: ContentKind;
  source: Exclude<ContentKindSource, 'manual'>;
  /** 给人看的判定依据（ImageDetail.kindReason） */
  evidence: string | null;
}

const SCREENSHOT_NAME =
  /^(screenshot|screen[ _]?shot|screencap|screenrecord|snipaste|截屏|截图|屏幕截图|qq截图|微信截图|wechat ?screenshot)[_\-\s]?|^\d{3,9}@\d{10}@\d+\.png$/i;
const SCREENSHOT_DIR = /^(screenshots?|screen ?shots?|截屏|截图|屏幕截图|录屏)$/i;
/** 锚定整段目录名：「表情差分」这类立绘文件夹不算（VF-meme） */
const MEME_DIR = /^(表情包?\d*|表情图|斗图|stickers?|emojis?|memes?|reactions?)$/i;
const PHOTO_NAME = /^(wx_camera_|mmexport_camera)/i;
const COMIC_DIR = /第?\s*\d+\s*[话話]\s*$/;
/** 手机屏幕尺寸（竖版；横版按对调算）。故意不收 16:9 的 1080x1920、720x1280：那是壁纸和 CG 的常见尺寸 */
const PHONE = new Set([
  '1080x2244', '1080x2340', '1080x2400', '1170x2532', '1284x2778', '1179x2556', '1290x2796', '1125x2436', '1242x2688', '828x1792',
  '1440x3200', '1440x3120', '1080x2280', '1080x2310', '1080x2159', '720x1520', '720x1600', '1200x2640', '1440x3040', '1080x2376',
  '1080x2408',
]);
/** 1080x2160 里一半以上是手机壁纸插画：打过标签、不满足插画保护才算截图（VF-screenshot） */
const PHONE_TAGGED_ONLY = new Set(['1080x2160']);
/** iPhone 16:9 / 18:9：这个库里基本都是截图（VF-screenshot） */
const PHONE_EXTRA = new Set(['750x1334', '1242x2208', '720x1440']);
/** 手机相机传感器尺寸（只对 JPEG）：QQ / 微信传过来的照片没有 EXIF，靠它认（VF-photo）。不含 4000x3000（多是数字插画） */
const CAMERA_SIZE = new Set([
  '3024x4032', '2976x3968', '3970x2976', '3264x2448', '4160x3120', '4608x3456', '4624x3472', '3456x4608', '3472x4624', '3120x4160',
  '2448x3264',
]);
const TEXT_LANG = ['chinese_text', 'english_text', 'korean_text', 'simplified_chinese_text', 'traditional_chinese_text', 'mixed-language_text'];
const UI_TAGS = ['fake_screenshot', 'user_interface', 'chat_log', 'heads-up_display', 'health_bar', 'fake_phone_screenshot'];
const DOC_PHOTO_TAGS = ['paper', 'notebook', 'math'];
const PERSON_TAGS = ['1girl', '1boy', 'solo'];
const SCENE_TAGS = ['still_life', 'scenery', 'computer', 'monitor'];
const PAINTERLY = ['traditional_media', 'painting_(medium)', 'faux_traditional_media', 'fine_art_parody'];
const GUARD_TAGS = ['1girl', '1boy', 'solo', 'multiple_girls'];

/** 分类器读的全部标签（批量回填时只取这些） */
export const SIGNAL_TAGS: readonly string[] = [
  ...new Set([
    'text_focus', 'wall_of_text', 'meme', 'panda', 'no_humans', 'realistic', 'photorealistic', 'real_life_insert', 'artist_self-insert',
    'comic', '4koma', 'speech_bubble', 'monochrome', 'greyscale', 'qr_code', 'parody',
    ...UI_TAGS, ...DOC_PHOTO_TAGS, ...PERSON_TAGS, ...SCENE_TAGS, ...PAINTERLY, ...GUARD_TAGS, ...TEXT_LANG,
  ]),
];

export const COMIC_ROOT_EVIDENCE = '按漫画导入的文件夹';

const fmt = (n: number) => n.toFixed(2).replace(/0$/, '');

export function classifyContent(x: ClassifyInput): ClassifyResult {
  const segs = x.relPath.split('/').slice(0, -1);
  const tags = x.tags;
  const t = (k: string) => tags?.get(k) ?? 0;
  const top = (keys: readonly string[]) => keys.reduce<[string, number]>((m, k) => (t(k) > m[1] ? [k, t(k)] : m), ['', 0]);
  const anyAt = (keys: readonly string[], th: number) => keys.some((k) => t(k) >= th);
  const cite = (...keys: string[]) =>
    '识别标签 ' +
    keys
      .filter((k) => t(k) > 0)
      .map((k) => `${k} ${fmt(t(k))}`)
      .join(' · ');
  const sized = `${x.width}×${x.height}`;

  const textHeavy = !!tags && (t('text_focus') >= 0.5 || t('wall_of_text') >= 0.4);

  // 0 用户导入时说了这个文件夹是漫画
  if (x.comicRoot) return { kind: 'comic', source: 'folder', evidence: COMIC_ROOT_EVIDENCE };

  // 1 强信号：文件名 / 文件夹 / 相机
  if (SCREENSHOT_NAME.test(x.fileName)) return { kind: 'screenshot', source: 'name', evidence: '文件名像截图' };
  const shotDir = segs.find((s) => SCREENSHOT_DIR.test(s));
  if (shotDir) return { kind: 'screenshot', source: 'folder', evidence: `文件夹「${shotDir}」` };
  const memeDir = segs.find((s) => MEME_DIR.test(s));
  if (memeDir) return { kind: 'meme', source: 'folder', evidence: `文件夹「${memeDir}」` };

  const exif = !!x.camera;
  const photoName = PHOTO_NAME.test(x.fileName);
  const camSize = x.format === 'jpeg' && (CAMERA_SIZE.has(`${x.width}x${x.height}`) || CAMERA_SIZE.has(`${x.height}x${x.width}`));
  if (exif || photoName || camSize) {
    const [source, evidence]: [ClassifyResult['source'], string] = exif
      ? ['camera', `相机拍摄（${x.camera}）`]
      : photoName
        ? ['name', '文件名像微信相机']
        : ['size', `尺寸 ${sized} 与手机相机一致`];
    if (textHeavy || (tags && anyAt(DOC_PHOTO_TAGS, 0.6))) return { kind: 'text', source, evidence: `${evidence}，内容以文字为主` };
    return { kind: 'photo', source, evidence };
  }
  if (x.format === 'gif') return { kind: 'animated', source: 'format', evidence: 'GIF 动图' };
  const comicDir = segs.find((s) => COMIC_DIR.test(s));
  if (comicDir) return { kind: 'comic', source: 'folder', evidence: `文件夹「${comicDir}」` };

  // 2 识别标签
  if (tags) {
    const mono = Math.max(t('monochrome'), t('greyscale'));
    const pandaMeme = t('panda') >= 0.6 && (t('no_humans') >= 0.5 || t('realistic') >= 0.4);
    if (t('meme') >= 0.5 || pandaMeme || t('real_life_insert') >= 0.45 || t('artist_self-insert') >= 0.5)
      return { kind: 'meme', source: 'tags', evidence: cite('meme', 'panda', 'real_life_insert', 'artist_self-insert') };
    if (anyAt(UI_TAGS, 0.5)) return { kind: 'screenshot', source: 'tags', evidence: cite(top(UI_TAGS)[0]) };
    const portrait = x.height >= x.width * 1.2;
    const comicHit =
      t('comic') >= 0.6 ||
      t('4koma') >= 0.5 ||
      (t('comic') >= 0.35 && portrait && ((t('speech_bubble') >= 0.5 && t('comic') >= 0.45) || mono >= 0.9));
    if (comicHit && !textHeavy) return { kind: 'comic', source: 'tags', evidence: cite('comic', '4koma', 'speech_bubble') };
    // 从漫画里截出来的横向单格：归表情
    if (t('comic') >= 0.35 && mono >= 0.9 && !textHeavy) return { kind: 'meme', source: 'tags', evidence: `分镜截取（${cite('comic')}）` };
    // 本子的人物介绍页、后记页（VF-text）
    if (textHeavy && anyAt(PERSON_TAGS, 0.85) && mono >= 0.9)
      return { kind: 'comic', source: 'tags', evidence: `本子页（${cite('text_focus', 'wall_of_text', 'monochrome')}）` };
    if (textHeavy || t('qr_code') >= 0.6) return { kind: 'text', source: 'tags', evidence: cite('text_focus', 'wall_of_text', 'qr_code') };
    if (anyAt(TEXT_LANG, 0.6) && t('no_humans') >= 0.6 && !anyAt(SCENE_TAGS, 0.6))
      return { kind: 'text', source: 'tags', evidence: cite(top(TEXT_LANG)[0], 'no_humans') };
    if ((t('realistic') >= 0.6 || t('photorealistic') >= 0.5) && !anyAt(PAINTERLY, 0.6)) {
      if (anyAt(TEXT_LANG, 0.5) || t('parody') >= 0.5)
        return { kind: 'meme', source: 'tags', evidence: cite('realistic', 'photorealistic', top(TEXT_LANG)[0], 'parody') };
      return { kind: 'photo', source: 'tags', evidence: cite('realistic', 'photorealistic') };
    }
  }

  // 3 弱信号：尺寸和手机屏幕完全一致
  const wh = `${x.width}x${x.height}`;
  const hw = `${x.height}x${x.width}`;
  const phone =
    PHONE.has(wh) || PHONE.has(hw) || PHONE_EXTRA.has(wh) || PHONE_EXTRA.has(hw) || (!!tags && (PHONE_TAGGED_ONLY.has(wh) || PHONE_TAGGED_ONLY.has(hw)));
  if (phone) {
    // 插画保护：打过标签、明显是人物插画、没有文字
    const guarded = !!tags && anyAt(GUARD_TAGS, 0.85) && !anyAt(TEXT_LANG, 0.35) && t('no_humans') < 0.3;
    if (!guarded) return { kind: 'screenshot', source: 'size', evidence: `尺寸 ${sized} 与手机屏幕一致` };
  }
  return { kind: 'illustration', source: tags ? 'tags' : 'default', evidence: null };
}
