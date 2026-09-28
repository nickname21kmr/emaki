import { describe, expect, it } from 'vitest';
import { readCameraFromExif } from './exif.ts';

/** 拼一个最小的小端 TIFF：IFD0 放 Make / Model（ASCII），可选 Exif 子 IFD 里放 DateTimeOriginal */
function tiff(make: string, model: string, shooting: boolean): Buffer {
  const strs = [Buffer.from(make + '\0', 'latin1'), Buffer.from(model + '\0', 'latin1')];
  const ifd0At = 8;
  const n0 = shooting ? 3 : 2;
  const ifd0Len = 2 + n0 * 12 + 4;
  let dataAt = ifd0At + ifd0Len;
  const exifAt = dataAt;
  const exifLen = shooting ? 2 + 12 + 4 : 0;
  dataAt += exifLen;
  const buf = Buffer.alloc(dataAt + strs[0]!.length + strs[1]!.length + 20);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifd0At, 4);
  buf.writeUInt16LE(n0, ifd0At);
  let off = dataAt;
  const entry = (at: number, tag: number, type: number, cnt: number, value: number) => {
    buf.writeUInt16LE(tag, at);
    buf.writeUInt16LE(type, at + 2);
    buf.writeUInt32LE(cnt, at + 4);
    buf.writeUInt32LE(value, at + 8);
  };
  [0x010f, 0x0110].forEach((tag, k) => {
    entry(ifd0At + 2 + k * 12, tag, 2, strs[k]!.length, off);
    strs[k]!.copy(buf, off);
    off += strs[k]!.length;
  });
  if (shooting) {
    entry(ifd0At + 2 + 2 * 12, 0x8769, 4, 1, exifAt);
    buf.writeUInt16LE(1, exifAt);
    entry(exifAt + 2, 0x9003, 2, 20, off);
    buf.write('2020:01:01 00:00:00\0', off, 'latin1');
  }
  return buf;
}

describe('readCameraFromExif', () => {
  it('手机拍的照片', () => {
    expect(readCameraFromExif(tiff('HUAWEI', 'EML-AL00', true))).toBe('HUAWEI EML-AL00');
    expect(readCameraFromExif(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff('Apple', 'iPhone X', true)]))).toBe('Apple iPhone X');
  });
  it('型号里已经带了品牌，不重复', () => {
    expect(readCameraFromExif(tiff('HUAWEI', 'HUAWEI WLZ-AN00', true))).toBe('HUAWEI WLZ-AN00');
  });
  it('没有拍摄参数、扫描仪、空数据都不算', () => {
    expect(readCameraFromExif(tiff('HUAWEI', 'EML-AL00', false))).toBe('');
    expect(readCameraFromExif(tiff('Canon', 'CanoScan LiDE 210', true))).toBe('');
    expect(readCameraFromExif(undefined)).toBe('');
    expect(readCameraFromExif(Buffer.from('garbage-data'))).toBe('');
  });
});
