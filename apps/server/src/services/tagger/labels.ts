/**
 * selected_tags.csv 解析。按表头找列（WD：tag_id,name,category,count；PixAI：id,tag_id,name,category,count,ips）。
 */
export interface Labels {
  /** 保留下划线原样，如 mika_(blue_archive) */
  names: string[];
  /** 0 general / 4 character / 9 rating */
  categories: Uint8Array;
  ratingIdx: number[];
  generalIdx: number[];
  characterIdx: number[];
  /** 画师（PixAI 的 style 类）；WD 没有这一类，为空 */
  artistIdx: number[];
}

/** 最小 RFC4180：支持引号、"" 转义、CRLF。真实文件里有 612924,"don't_say_""lazy""",0,1062 这种行 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

const RATING_ORDER = ['general', 'sensitive', 'questionable', 'explicit'];

export function parseSelectedTags(text: string): Labels {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  if (!header) throw new Error('标签表为空');
  const nameCol = header.indexOf('name');
  const catCol = header.indexOf('category');
  if (nameCol < 0 || catCol < 0) throw new Error(`标签表缺少 name / category 列：${header.join(',')}`);
  const names: string[] = [];
  const categories = new Uint8Array(rows.length);
  const ratingIdx: number[] = [];
  const generalIdx: number[] = [];
  const characterIdx: number[] = [];
  rows.forEach((r, i) => {
    names.push(r[nameCol] ?? '');
    const cat = Number(r[catCol]);
    categories[i] = cat;
    if (cat === 9) ratingIdx.push(i);
    else if (cat === 4) characterIdx.push(i);
    else if (cat === 0) generalIdx.push(i);
  });
  if (ratingIdx.length && ratingIdx.map((i) => names[i]).join() !== RATING_ORDER.join()) {
    throw new Error(`rating 标签顺序不对：${ratingIdx.map((i) => names[i]).join(',')}`);
  }
  return { names, categories, ratingIdx, generalIdx, characterIdx, artistIdx: [...categories.keys()].filter((i) => categories[i] === 1) };
}

/** PixAI v1 的类别 → 和 WD 一致的类别码（0 general / 1 artist·画风 / 3 copyright / 4 character / 5 meta / 9 rating） */
const PIXAI_CATEGORY: Record<string, number> = { general: 0, style: 1, copyright: 3, character: 4, meta: 5, rating: 9 };
const PIXAI_RATING: Record<string, string> = { 'rating:g': 'general', 'rating:s': 'sensitive', 'rating:q': 'questionable', 'rating:e': 'explicit' };

interface PixaiTagMap {
  num_classes: number;
  categories: { name: string; offset: number; count: number; tags: string[] }[];
}

/** PixAI v1 的 tags.json：各类别按 offset 拼成全局下标；rating:g 这类名字换成 general 等，和 WD 的 rating 输出同样用 */
export function parsePixaiTags(text: string): Labels {
  const map = JSON.parse(text) as PixaiTagMap;
  const n = map.num_classes;
  const names: string[] = new Array<string>(n).fill('');
  const categories = new Uint8Array(n).fill(255);
  for (const c of map.categories) {
    const code = PIXAI_CATEGORY[c.name];
    if (code === undefined) throw new Error(`tags.json 里有未知类别：${c.name}`);
    if (c.tags.length !== c.count || c.offset + c.count > n) throw new Error(`tags.json 的「${c.name}」数量不对`);
    c.tags.forEach((t, k) => {
      names[c.offset + k] = code === 9 ? (PIXAI_RATING[t] ?? t) : t;
      categories[c.offset + k] = code;
    });
  }
  if (categories.includes(255)) throw new Error('tags.json 没有覆盖全部输出');
  const idx = (code: number) => [...categories.keys()].filter((i) => categories[i] === code);
  const ratingIdx = RATING_ORDER.map((r) => names.indexOf(r));
  if (ratingIdx.some((i) => i < 0 || categories[i] !== 9)) throw new Error('tags.json 缺少 rating:g / s / q / e');
  return { names, categories, ratingIdx, generalIdx: idx(0), characterIdx: idx(4), artistIdx: idx(1) };
}

export function parseLabels(format: 'csv' | 'pixai-json', text: string): Labels {
  return format === 'pixai-json' ? parsePixaiTags(text) : parseSelectedTags(text);
}
