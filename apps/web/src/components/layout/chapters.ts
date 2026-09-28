import { toCjkDate } from '@/lib/format';

/** 页头的册号：mark 用品牌色（「第二册」），sub 是小题（「人物」） */
export interface Chapter {
  mark: string;
  sub: string;
}

const ANNEX_SUB: Record<string, string> = {
  comic: '漫画',
  screenshot: '截图',
  text: '文字',
  photo: '照片',
  meme: '表情',
  animated: '动图',
};

/** 按路由给出页头的册号（SEL-3）：整个应用是一套「私人相簿」，每个页面是其中一册 */
export function getChapter(pathname: string, now: Date = new Date()): Chapter {
  const [a, b] = pathname.split('/').filter(Boolean);
  switch (a) {
    case 'gallery':
      return { mark: '第一册', sub: '插画' };
    case 'characters':
      return { mark: '第二册', sub: '人物' };
    case 'works':
      return { mark: '第三册', sub: '作品' };
    case 'collections':
      return { mark: '合集', sub: '本子与画集' };
    case 'annex':
      return { mark: '别册', sub: ANNEX_SUB[b ?? ''] ?? '截图 · 漫画 · 文字 · 照片 · 表情 · 动图' };
    case 'unrecognized':
      return { mark: '整理', sub: '其一' };
    case 'duplicates':
      return { mark: '整理', sub: '其二' };
    case 'excluded':
      return { mark: '整理', sub: '其三' };
    case 'settings':
      return { mark: '附录', sub: '设置' };
    default:
      return { mark: '扉页', sub: toCjkDate(now) };
  }
}
