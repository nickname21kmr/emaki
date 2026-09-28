import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sharp } from '../../image/sharpConfig.ts';
import { parseCsv, parseSelectedTags } from '../labels.ts';
import { decodeRow, mcutThreshold, pickRating } from '../postprocess.ts';
import { preprocessWdV3 } from '../preprocess.ts';

const REAL_CSV = path.resolve(import.meta.dirname, '../../../../../../data/models/SmilingWolf__wd-eva02-large-tagger-v3/selected_tags.csv');

describe('labels', () => {
  it('小 CSV：CRLF、"" 转义、各类下标', () => {
    const csv =
      '﻿tag_id,name,category,count\r\n' +
      '1,general,9,1\r\n2,sensitive,9,1\r\n3,questionable,9,1\r\n4,explicit,9,1\r\n' +
      '5,1girl,0,9\r\n612924,"don\'t_say_""lazy""",0,1062\r\n7,mika_(blue_archive),4,5\r\n';
    const L = parseSelectedTags(csv);
    expect(L.names[5]).toBe('don\'t_say_"lazy"');
    expect(L.ratingIdx).toEqual([0, 1, 2, 3]);
    expect(L.generalIdx).toEqual([4, 5]);
    expect(L.characterIdx).toEqual([6]);
  });

  it('parseCsv 丢弃空行', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it.skipIf(!existsSync(REAL_CSV))('真实的 WD v3 标签表', () => {
    const L = parseSelectedTags(readFileSync(REAL_CSV, 'utf8'));
    expect(L.names.length).toBe(10861);
    expect(L.ratingIdx).toEqual([0, 1, 2, 3]);
    expect([L.generalIdx[0], L.generalIdx.length]).toEqual([4, 8106]);
    expect([L.characterIdx[0], L.characterIdx.length]).toEqual([8110, 2751]);
  });
});

describe('postprocess', () => {
  it('mcut', () => expect(mcutThreshold([0.9, 0.8, 0.2, 0.1])).toBeCloseTo(0.5));

  it('decodeRow', () => {
    const L = parseSelectedTags(
      'tag_id,name,category,count\n1,general,9,1\n2,sensitive,9,1\n3,questionable,9,1\n4,explicit,9,1\n5,1girl,0,1\n6,solo,0,1\n7,mika_(blue_archive),4,1\n',
    );
    const p = new Float32Array([0.1, 0.7, 0.15, 0.05, 0.99, 0.2, 0.93]);
    const d = decodeRow(p, 0, L, { generalThreshold: 0.35, characterThreshold: 0.35 });
    expect(pickRating(d.rating!)).toBe('sensitive');
    expect(d.general).toEqual([['1girl', 0.99]]);
    expect(d.character).toEqual([['mika_(blue_archive)', 0.93]]);
  });
});

describe('preprocess', () => {
  const px = (a: Float32Array, x: number, y: number) => [...a.subarray((y * 448 + x) * 3, (y * 448 + x) * 3 + 3)];

  it('红色横图：BGR、居中、上下补白', async () => {
    const buf = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
    const a = await preprocessWdV3(buf);
    expect(a.length).toBe(448 * 448 * 3);
    const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(Math.abs(v - want[i]!)).toBeLessThanOrEqual(2));
    near(px(a, 224, 224), [0, 0, 255]);
    near(px(a, 5, 5), [255, 255, 255]);
    near(px(a, 224, 440), [255, 255, 255]);
  });

  it('全透明 → 全白', async () => {
    const buf = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const a = await preprocessWdV3(buf);
    let min = 255;
    for (let i = 0; i < a.length; i++) if (a[i]! < min) min = a[i]!; // Math.min(...a) 会栈溢出
    expect(min).toBeGreaterThanOrEqual(253);
  });
});
