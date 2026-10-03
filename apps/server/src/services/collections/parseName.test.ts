import { describe, expect, it } from 'vitest';
import { parseFolderName } from './parseName.ts';

describe('parseFolderName', () => {
  it('① 汉化组、展会、社团、作者、原作', () => {
    expect(parseFolderName('[某汉化组] (C95) [社团甲 (作者乙)] 标题丙 (原作丁)')).toMatchObject({
      title: '标题丙',
      event: 'C95',
      circle: '社团甲',
      artist: '作者乙',
      parody: '原作丁',
      translator: '某汉化组',
    });
  });
  it('② 结尾的 [某家族社] 算汉化组', () => {
    expect(parseFolderName('(C96) [社团 (作者)] 标题 [某家族社]')).toMatchObject({ translator: '某家族社', title: '标题' });
  });
  it('③ 只有社团、带副题和原作', () => {
    expect(parseFolderName('(C94) [社团] 标题4 副题 (东方Project)')).toMatchObject({
      circle: '社团',
      artist: null,
      title: '标题4 副题',
      parody: '东方Project',
    });
  });
  it('④ 上卷', () => {
    expect(parseFolderName('[作者] 标题♡ 上')).toMatchObject({ circle: '作者', title: '标题♡', seriesKey: '标题♡', volumeNo: 1 });
  });
  it('⑤ 下卷', () => {
    expect(parseFolderName('[作者] 标题♡ 下')).toMatchObject({ volumeNo: 3 });
  });
  it('⑥ N话', () => {
    expect(parseFolderName('某连载 12话')).toMatchObject({ title: '某连载', seriesKey: '某连载', volumeNo: 12 });
  });
  it('⑦ 第N话', () => {
    expect(parseFolderName('某连载 第3话')).toMatchObject({ volumeNo: 3 });
  });
  it('⑧ NFD 编码先转 NFC', () => {
    expect(parseFolderName('标题 (原作ベ) (1)')).toMatchObject({ parody: '原作ベ', volumeNo: 1, seriesKey: '标题' });
  });
  it('⑨ FF30【社团】', () => {
    expect(parseFolderName('FF30【 社团 】标题!!')).toMatchObject({ event: 'FF30', circle: '社团', title: '标题!!' });
  });
  it('⑩ [C83]【社团】+ 格式标记', () => {
    expect(parseFolderName('[C83]【社团】作者 - 标题 17 ╱副题[JPG_22P]')).toMatchObject({
      event: 'C83',
      circle: '社团',
      title: '作者 - 标题 17 ╱副题',
    });
  });
  it('⑪ 某画师画集', () => {
    expect(parseFolderName('某画师画集 标题！')).toMatchObject({ artist: '某画师', title: '标题！' });
  });
  it('⑫ 书名号', () => {
    expect(parseFolderName('《某某ビジュアルファンブック》')).toMatchObject({ title: '某某ビジュアルファンブック' });
  });
  it('⑬ 只有【】', () => {
    expect(parseFolderName('【12345】')).toMatchObject({ title: '12345', circle: null });
  });
  it('⑭ 十六进制名没有标题；(JPG) 格式标记去掉', () => {
    expect(parseFolderName('5cf966d0aae1cb28835ce0bd').title).toBeNull();
    expect(parseFolderName('Some Artist - W (JPG)').title).toBe('Some Artist - W');
  });
});

describe('画集名后面只有卷号、括号里是备注', () => {
  it('「FANTIA 作品集 2 (ex-hentai 159P …)」：书名保留整串，记成第 2 卷，括号不当原作', () => {
    expect(parseFolderName('FANTIA 作品集 2 (ex-hentai 159P 2020.06-2021.07)')).toMatchObject({
      title: 'FANTIA 作品集 2',
      artist: null,
      parody: null,
      seriesKey: 'FANTIA 作品集',
      volumeNo: 2,
    });
  });
  it('括号里是自整理、页数、日期的不算原作；真正的原作照旧', () => {
    expect(parseFolderName('PIXIV 全投稿作品集 (自整理 703P 截止2022.01.04)').parody).toBeNull();
    expect(parseFolderName('某本子 (東方Project)').parody).toBe('東方Project');
  });
});
