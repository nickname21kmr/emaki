import { expect, it } from 'vitest';
import { toCjkDate } from '@/lib/format';
import { getChapter } from './chapters';

it('按路由给册号', () => {
  expect(getChapter('/characters/12')).toEqual({ mark: '第二册', sub: '人物' });
  expect(getChapter('/annex/photo')).toEqual({ mark: '别册', sub: '照片' });
  expect(getChapter('/annex').sub).toBe('截图 · 漫画 · 文字 · 照片 · 表情 · 动图');
  expect(getChapter('/settings')).toEqual({ mark: '附录', sub: '设置' });
  const now = new Date(2026, 8, 27);
  expect(getChapter('/', now)).toEqual({ mark: '扉页', sub: toCjkDate(now) });
});
