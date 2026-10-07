import type { ContentKind, ImageFormat } from '@emaki/shared';
import { describe, expect, it } from 'vitest';
import { classifyContent, type ClassifyResult } from './rules.ts';

interface Case {
  name: string;
  path?: string;
  w?: number;
  h?: number;
  format?: ImageFormat;
  camera?: string | null;
  tags?: Record<string, number> | null;
  kind: ContentKind;
  source?: ClassifyResult['source'];
}

// 用例取真实库样本（03-content-kind.md CL「四、分类器」和 VF 各节）
const CASES: Case[] = [
  { name: 'Screenshot_ 文件名', path: 'screenshot/Screenshot_2018-08-16-10-39-09.jpg', w: 1080, h: 2244, format: 'jpeg', kind: 'screenshot', source: 'name' },
  { name: 'B 站逐帧截图', path: '1239538@1565074250@1.png', kind: 'screenshot', source: 'name' },
  { name: '截图文件夹', path: 'screenshot/12345678901234567.png', kind: 'screenshot', source: 'folder' },
  { name: '表情包文件夹', path: '表情包2/1540906292056.jpeg', format: 'jpeg', kind: 'meme', source: 'folder' },
  { name: '表情包文件夹里的 gif 仍是表情', path: '表情包2/a.gif', format: 'gif', kind: 'meme', source: 'folder' },
  { name: '表情差分不是表情包', path: '立绘/表情差分/01.png', kind: 'illustration', source: 'default' },
  { name: 'N话 文件夹', path: '半夜的X仪式 3话/012.jpg', format: 'jpeg', kind: 'comic', source: 'folder' },
  { name: 'gif → 动图', path: 'a.gif', format: 'gif', kind: 'animated', source: 'format' },
  { name: '漫画标签', tags: { comic: 0.93, monochrome: 0.99, speech_bubble: 0.7 }, kind: 'comic', source: 'tags' },
  { name: '低分漫画 + 单色 + 竖版', w: 1000, h: 1500, tags: { comic: 0.46, monochrome: 0.99 }, kind: 'comic', source: 'tags' },
  { name: '低分漫画 + 单色 + 横版 → 分镜截取', w: 1500, h: 1000, tags: { comic: 0.46, monochrome: 0.99 }, kind: 'meme', source: 'tags' },
  { name: '熊猫头', tags: { text_focus: 0.86, comic: 0.84, panda: 0.9, no_humans: 0.8 }, kind: 'meme', source: 'tags' },
  { name: '熊猫发饰的插画', tags: { '1girl': 0.99, panda: 0.65 }, kind: 'illustration', source: 'tags' },
  { name: 'cosplay 标签不算照片', tags: { cosplay: 0.98, '1girl': 1 }, kind: 'illustration', source: 'tags' },
  { name: '油画', tags: { realistic: 0.93, traditional_media: 0.89, 'painting_(medium)': 0.9 }, kind: 'illustration', source: 'tags' },
  { name: '写实 → 照片', tags: { realistic: 0.8 }, kind: 'photo', source: 'tags' },
  { name: '写实 + 中文 → 梗图', tags: { realistic: 0.7, chinese_text: 0.9 }, kind: 'meme', source: 'tags' },
  { name: '相机 + 笔记', format: 'jpeg', camera: 'HUAWEI EML-AL00', tags: { text_focus: 0.6, math: 0.8 }, kind: 'text', source: 'camera' },
  { name: '相机实拍', format: 'jpeg', camera: 'HUAWEI EML-AL00', kind: 'photo', source: 'camera' },
  { name: '微信相机文件名', path: 'WeiXin/wx_camera_1590000000000.jpg', format: 'jpeg', camera: '', kind: 'photo', source: 'name' },
  { name: '1080x2160 未打标签不判截图', w: 1080, h: 2160, tags: null, kind: 'illustration', source: 'default' },
  { name: '1080x2160 打过标签、没有人物 → 截图', w: 1080, h: 2160, tags: { text_focus: 0.3 }, kind: 'screenshot', source: 'size' },
  { name: '1080x2160 人物插画受保护', w: 1080, h: 2160, tags: { '1girl': 0.99, solo: 0.98 }, kind: 'illustration', source: 'tags' },
  { name: '手机屏幕尺寸、未打标签', w: 1080, h: 2244, kind: 'screenshot', source: 'size' },
  { name: '横版手机屏幕', w: 2244, h: 1080, kind: 'screenshot', source: 'size' },
  { name: 'iPhone 16:9 截图', path: 'QQ_Images/x.jpg', w: 750, h: 1334, format: 'jpeg', camera: '', tags: null, kind: 'screenshot', source: 'size' },
  { name: 'iPhone 16:9 人物插画受保护', w: 750, h: 1334, tags: { '1girl': 0.99, solo: 0.97 }, kind: 'illustration', source: 'tags' },
  { name: '1080x1920 壁纸不收', w: 1080, h: 1920, kind: 'illustration', source: 'default' },
  { name: '本子人物介绍页', w: 1200, h: 1700, tags: { text_focus: 0.82, '1girl': 1, monochrome: 0.99, greyscale: 0.99 }, kind: 'comic', source: 'tags' },
  { name: '相机尺寸的 jpeg', path: 'QQ_Images/-2146003eb6ff6487.jpg', w: 3024, h: 4032, format: 'jpeg', camera: '', tags: null, kind: 'photo', source: 'size' },
  { name: '相机尺寸但不是 jpeg', w: 3024, h: 4032, format: 'png', kind: 'illustration', source: 'default' },
  { name: '4000x3000 不算相机尺寸', w: 4000, h: 3000, format: 'jpeg', camera: '', kind: 'illustration', source: 'default' },
  { name: '小图文字仍归文字（不采纳 tags-smalltext）', w: 600, h: 600, tags: { text_focus: 0.86 }, kind: 'text', source: 'tags' },
  { name: '二维码', tags: { qr_code: 0.9 }, kind: 'text', source: 'tags' },
  { name: '中文 + 无人 → 文字', tags: { chinese_text: 0.8, no_humans: 0.9 }, kind: 'text', source: 'tags' },
  { name: '中文 + 无人 + 风景 → 插画', tags: { chinese_text: 0.8, no_humans: 0.9, scenery: 0.8 }, kind: 'illustration', source: 'tags' },
  { name: '聊天记录标签', tags: { chat_log: 0.7 }, kind: 'screenshot', source: 'tags' },
  { name: '漫画但文字为主 → 文字', tags: { comic: 0.8, text_focus: 0.7 }, kind: 'text', source: 'tags' },
  { name: '普通插画', path: 'pixiv/12345_p0.png', w: 1200, h: 1700, tags: { '1girl': 0.99 }, kind: 'illustration', source: 'tags' },
];

describe('classifyContent', () => {
  it.each(CASES)('$name', (c) => {
    const path = c.path ?? 'a/b.png';
    const r = classifyContent({
      fileName: path.split('/').at(-1)!,
      relPath: path,
      width: c.w ?? 1200,
      height: c.h ?? 1700,
      format: c.format ?? 'png',
      camera: c.camera ?? null,
      tags: c.tags === undefined || c.tags === null ? null : new Map(Object.entries(c.tags)),
    });
    expect(r.kind).toBe(c.kind);
    if (c.source) expect(r.source).toBe(c.source);
  });

  it('判定依据写成人话', () => {
    const r = classifyContent({ fileName: 'a.jpg', relPath: '表情包2/a.jpg', width: 1, height: 1, format: 'jpeg', camera: null, tags: null });
    expect(r.evidence).toBe('文件夹「表情包2」');
    const t = classifyContent({ fileName: 'a.png', relPath: 'a.png', width: 1200, height: 1700, format: 'png', camera: null, tags: new Map([['comic', 0.93]]) });
    expect(t.evidence).toBe('识别标签 comic 0.93');
  });

  it('按漫画导入的文件夹：不看文件名、尺寸、标签，都是漫画', () => {
    for (const [fileName, tags] of [['Screenshot_1.png', null], ['a.png', new Map([['1girl', 0.99]])]] as const) {
      const r = classifyContent({ fileName, relPath: `Vol.01/${fileName}`, width: 1080, height: 2400, format: 'png', camera: null, tags, comicRoot: true });
      expect(r).toEqual({ kind: 'comic', source: 'folder', evidence: '按漫画导入的文件夹' });
    }
  });
});
