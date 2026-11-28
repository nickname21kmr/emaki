import { expect, it } from 'vitest';
import { imageUrl } from './api';

const params = (url: string) => new URL(url, 'http://emaki.test').searchParams;

it('缩略图地址带文件版本 v（服务端核对它才回长缓存）和缩略图做法的版本 tv', () => {
  const modifiedAt = '2026-10-24T10:00:00.000Z';
  const url = imageUrl.thumb('12', 960, modifiedAt);
  expect(url.startsWith('/api/images/12/thumb?')).toBe(true);
  expect([params(url).get('w'), params(url).get('v')]).toEqual(['960', modifiedAt]);
  expect(params(url).get('tv')).toMatch(/^\d+$/);
});

it('没有文件版本的调用不带 v（服务端照旧每次核对），tv 照带', () => {
  const bare = params(imageUrl.thumb('12'));
  expect([bare.get('w'), bare.has('v')]).toEqual(['480', false]);
  expect(bare.get('tv')).toBe(params(imageUrl.thumb('12', 240, 'x')).get('tv'));
});
