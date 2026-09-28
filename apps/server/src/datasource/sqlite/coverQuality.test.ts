import { expect, it } from 'vitest';
import { coverQuality } from '../../services/covers/quality.ts';

const base = { w: 1000, h: 1350, fileName: 'a.jpg', fav: 0, cs: 0.95, others: 0 };

it('聊天记录截图输给干净的单人图，即使它的角色分数更高', () => {
  const chat = coverQuality({ ...base, cs: 1, w: 1080, h: 2340 }, [['chat_log', 0.9], ['english_text', 0.8]]);
  const solo = coverQuality({ ...base, cs: 0.8 }, [['solo', 0.98], ['looking_at_viewer', 0.9]]);
  expect(solo).toBeGreaterThan(chat);
});

it('没打标签时，文件名像截图、尺寸像手机屏幕也会往后排', () => {
  expect(coverQuality({ ...base, fileName: 'Screenshot_2021-01-16.png' }, [])).toBeLessThan(coverQuality(base, []) - 50);
  expect(coverQuality({ ...base, w: 1080, h: 2400 }, [])).toBeLessThan(coverQuality(base, []) - 20);
});

it('高分辨率、单人、竖图优先；漫画格和黑白往后', () => {
  const good = coverQuality({ ...base, w: 1500, h: 2000 }, [['solo', 0.98]]);
  const comic = coverQuality(base, [['comic', 0.9], ['monochrome', 0.95]]);
  const small = coverQuality({ ...base, w: 300, h: 400 }, [['solo', 0.98]]);
  expect(good).toBeGreaterThan(comic);
  expect(good).toBeGreaterThan(small);
});

it('截图、聊天记录、文字图不能当封面', async () => {
  const { isUnfitCover } = await import('../../services/covers/quality.ts');
  expect(isUnfitCover('Screenshot_2021.png', [])).toBe(true);
  expect(isUnfitCover('a.jpg', [['chat_log', 0.7]])).toBe(true);
  expect(isUnfitCover('a.jpg', [['text_focus', 0.6]])).toBe(true);
  expect(isUnfitCover('a.jpg', [['solo', 0.9], ['chat_log', 0.3]])).toBe(false);
});
