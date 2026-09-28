import { expect, it } from 'vitest';
import { toCjkDate } from './format';

it('toCjkDate：年份逐字、月日用「十」、星期几', () => {
  const cases: [number, number, number, string][] = [
    [2026, 9, 1, '二〇二六年九月一日　星期二'],
    [2026, 9, 10, '二〇二六年九月十日　星期四'],
    [2026, 9, 11, '二〇二六年九月十一日　星期五'],
    [2026, 9, 20, '二〇二六年九月二十日　星期日'],
    [2026, 9, 27, '二〇二六年九月二十七日　星期日'],
    [2026, 10, 31, '二〇二六年十月三十一日　星期六'],
    [2026, 12, 31, '二〇二六年十二月三十一日　星期四'],
    [2030, 1, 1, '二〇三〇年一月一日　星期二'],
  ];
  for (const [y, m, d, want] of cases) expect(toCjkDate(new Date(y, m - 1, d))).toBe(want);
});
