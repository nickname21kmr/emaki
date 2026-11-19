/**
 * 内容类型的图标（T27 / T32a）。插画是主角，其余五类统称「别册」。
 * 键位顺序 = CONTENT_KINDS 顺序：1 插画 2 漫画 3 截图 4 文字 5 照片 6 表情。
 * 类型的名称、印章字、说明只有一份，在 packages/shared（KIND_LABEL / KIND_GLYPH / KIND_HINT，附录 #38），这里转出来。
 * 「动图」不是类型（D5）：是另一个维度（ImageItem.animated），按帧数自动判断，文案在下面的 ANIMATED_*。
 */
import type { ContentKind, ContentKindSource } from '@emaki/shared';
import { BookOpen, Camera, FileText, Image, Smartphone, Sticker, type LucideIcon } from 'lucide-react';

export { KIND_GLYPH, KIND_HINT, KIND_LABEL } from '@emaki/shared';

export const KIND_ICON: Record<ContentKind, LucideIcon> = {
  illustration: Image,
  comic: BookOpen,
  screenshot: Smartphone,
  text: FileText,
  photo: Camera,
  meme: Sticker,
};

export const SOURCE_LABEL: Record<ContentKindSource, string> = {
  name: '文件名',
  folder: '文件夹',
  camera: '相机信息',
  size: '尺寸',
  tags: '识别标签',
  manual: '手动',
  default: '默认',
};

/** 动图（D5）：不是类型，是跨类型的筛选 */
export const ANIMATED_LABEL = '动图';

/** 当前看的这几类一共多少张；'all' 就是全库 */
export const kindTotal = (counts: Record<ContentKind, number>, total: number, kind: ContentKind[] | 'all') =>
  kind === 'all' ? total : kind.reduce((n, k) => n + (counts[k] ?? 0), 0);

