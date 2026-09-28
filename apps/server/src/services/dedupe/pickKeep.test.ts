import { expect, it } from 'vitest';
import { pickKeep, type KeepCandidate } from './pickKeep.ts';

const c = (id: number, file_name: string, o: Partial<KeepCandidate> = {}): KeepCandidate => ({
  id,
  file_name,
  width: 1000,
  height: 1000,
  bytes: 5000,
  added_at: '2026-01-01T00:00:00.000Z',
  ...o,
});

it('同尺寸同大小：不像副本的文件名胜出', () => {
  expect(pickKeep([c(1, 'a (1).png'), c(2, 'a - 副本.png'), c(3, 'a.png')]).file_name).toBe('a.png');
  expect(pickKeep([c(1, 'a - Copy (2).png'), c(2, 'a.png')]).file_name).toBe('a.png');
});

it('分辨率高的优先，其次体积', () => {
  expect(pickKeep([c(1, 'a.png'), c(2, 'a (1).png', { width: 2000 })]).id).toBe(2);
  expect(pickKeep([c(1, 'a.png'), c(2, 'b.png', { bytes: 9000 })]).id).toBe(2);
});

it('其余都一样：入库早的、id 小的', () => {
  expect(pickKeep([c(1, 'a.png', { added_at: '2026-02-01T00:00:00.000Z' }), c(2, 'b.png')]).id).toBe(2);
  expect(pickKeep([c(5, 'a.png'), c(3, 'b.png')]).id).toBe(3);
});
