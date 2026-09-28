/**
 * 内容类型的文案与图标（T27 / T32a）。插画是主角，其余六类统称「别册」。
 * 键位顺序 = CONTENT_KINDS 顺序：1 插画 2 漫画 3 截图 4 文字 5 照片 6 表情 7 动图。
 */
import type { ContentKind, ContentKindSource } from '@emaki/shared';
import { BookOpen, Camera, FileText, Film, Image, Smartphone, Sticker, type LucideIcon } from 'lucide-react';

export const KIND_LABEL: Record<ContentKind, string> = {
  illustration: '插画',
  comic: '漫画',
  screenshot: '截图',
  text: '文字',
  photo: '照片',
  meme: '表情',
  animated: '动图',
};

/** 朱文小印上的字（T32b） */
export const KIND_GLYPH: Record<ContentKind, string> = {
  illustration: '插',
  comic: '漫',
  screenshot: '截',
  text: '文',
  photo: '照',
  meme: '表',
  animated: '动',
};

export const KIND_HINT: Record<ContentKind, string> = {
  illustration: '单幅插画、CG、立绘、封面',
  comic: '漫画和本子的内页、分镜、四格',
  screenshot: '手机电脑截屏、聊天记录、视频截图',
  text: '文档、笔记、满屏文字、二维码',
  photo: '相机拍的照片、真人、实物',
  meme: '表情包、梗图、反应图',
  animated: 'GIF 动图',
};

export const KIND_ICON: Record<ContentKind, LucideIcon> = {
  illustration: Image,
  comic: BookOpen,
  screenshot: Smartphone,
  text: FileText,
  photo: Camera,
  meme: Sticker,
  animated: Film,
};

export const SOURCE_LABEL: Record<ContentKindSource, string> = {
  name: '文件名',
  folder: '文件夹',
  camera: '相机信息',
  format: '格式',
  size: '尺寸',
  tags: '识别标签',
  manual: '手动',
  default: '默认',
};

/** 别册总数 = 非插画之和 */
export const annexTotal = (counts: Record<ContentKind, number> | undefined) =>
  counts ? Object.entries(counts).reduce((n, [k, v]) => (k === 'illustration' ? n : n + v), 0) : 0;
