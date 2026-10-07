import { describe, expect, it } from 'vitest';
import { parseComicDir, parseFolderName } from './parseName.ts';

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

describe('parseComicDir（按漫画导入的文件夹）', () => {
  const root = 'F:/新建文件夹/魔都精兵的奴隶';
  const A = '[タカヒロ×竹村洋平][魔都精兵的奴隶][东立][Vol.01-Vol.11][未完].zip';
  it.each([
    [`${A}/魔都精兵的奴隶 Vol.01/pics`, '魔都精兵的奴隶', 1],
    [`${A}/魔都精兵的奴隶 Vol.04/6卷`, '魔都精兵的奴隶', 6],
    [`${A}/魔都精兵的奴隶 Vol.10/第10卷`, '魔都精兵的奴隶', 10],
    ['Series A/第12话', 'Series A', 12],
    ['某漫画 (2)', '某漫画', 2],
    ['第3话', '魔都精兵的奴隶', 3],
    ['one-shot', 'one-shot', null],
    ['', '魔都精兵的奴隶', null],
    // 范围（整套）不是卷号，书名去掉方括号
    [A, '魔都精兵的奴隶', null],
    [`${A}/pics`, '魔都精兵的奴隶', null],
    [`${A}/魔都精兵的奴隶_Vol.04`, '魔都精兵的奴隶', 4],
    ['某漫画 全10卷/01', '某漫画', 1],
    ['某漫画 第1-5卷/第3卷', '某漫画', 3],
    ['作品 1-11卷', '作品', null],
    // 话数优先、副标题不当系列名、纯数字目录、中文数字、Chapter / v04 / 小数
    ['某漫画/第001话 出会い', '某漫画', 1],
    ['X Vol.04/X Vol.04 第28话', 'X', 28],
    ['某漫画 Vol.04/彩页', '某漫画', 4],
    ['某漫画/001', '某漫画', 1],
    ['某漫画/第十二话', '某漫画', 12],
    ['某漫画/卷01', '某漫画', 1],
    ['S/Chapter 12', 'S', 12],
    ['S/VOL_03', 'S', 3],
    ['S/v04', 'S', 4],
    ['番外 第3.5话', '番外', 3.5],
    ['Vol.01/Chapter 001', '魔都精兵的奴隶', 1],
    ['[作者][作品][东立][Vol.01].zip', '作品', 1],
  ])('%s → %s 第 %s 卷', (dir, title, vol) => {
    const p = parseComicDir(dir, root);
    expect([p.title, p.volumeNo, p.seriesKey]).toEqual([title, vol, vol === null ? null : title]);
  });
  it('作者从外层的 [作者] 里取', () => {
    expect(parseComicDir(`${A}/魔都精兵的奴隶 Vol.01/pics`, root).circle).toBe('タカヒロ×竹村洋平');
  });
});
