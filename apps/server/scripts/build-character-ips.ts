/**
 * 生成离线的「角色 → 作品」对照表 apps/server/assets/character-ips.json。
 *   npx tsx apps/server/scripts/build-character-ips.ts
 *
 * 数据来自 deepghs/pixai-tagger-v0.9-onnx 的 selected_tags.csv（ips 列，Apache-2.0），覆盖 WD v3 角色 98.3%。
 * 每个角色的作品按「出现频次降序、名字升序」排，第一个就是母 IP（fate_(series)、precure…）。
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.ts';
import { httpFetch } from '../src/net/http.ts';
import { parseCsv } from '../src/services/tagger/labels.ts';

const REV = 'd8cf666911a2c3d10d586d7823259192313c7eb7';
const SIZE = 596868;
const SHA = '76b5dd39354a7a4d9baefb94d63b44a09a4934ee15303b7eb86c38f2128eb68a';

async function download(): Promise<string> {
  const errors: string[] = [];
  for (const host of ['https://huggingface.co', 'https://hf-mirror.com']) {
    try {
      const res = await httpFetch(`${host}/deepghs/pixai-tagger-v0.9-onnx/resolve/${REV}/selected_tags.csv`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const sha = createHash('sha256').update(buf).digest('hex');
      if (buf.length !== SIZE || sha !== SHA) throw new Error(`校验失败（${buf.length} 字节，sha ${sha.slice(0, 12)}…）`);
      return buf.toString('utf8');
    } catch (err) {
      errors.push(`${host}：${(err as Error).message}`);
    }
  }
  throw new Error(`下载失败：${errors.join('；')}`);
}

const [header, ...rows] = parseCsv((await download()).replace(/^﻿/, ''));
const col = (name: string) => {
  const i = header!.indexOf(name);
  if (i < 0) throw new Error(`缺少列 ${name}`);
  return i;
};
const [nameCol, catCol, ipsCol] = [col('name'), col('category'), col('ips')];

const raw = new Map<string, string[]>();
for (const r of rows) {
  if (r[catCol] !== '4') continue;
  let ips: unknown;
  try {
    ips = JSON.parse(r[ipsCol] ?? '[]');
  } catch {
    continue;
  }
  if (Array.isArray(ips) && ips.length && ips.every((x) => typeof x === 'string')) raw.set(r[nameCol]!, ips as string[]);
}

const freq = new Map<string, number>();
for (const ips of raw.values()) for (const ip of ips) freq.set(ip, (freq.get(ip) ?? 0) + 1);
const characters: Record<string, string[]> = {};
for (const name of [...raw.keys()].sort()) {
  characters[name] = [...new Set(raw.get(name))].sort((a, b) => freq.get(b)! - freq.get(a)! || a.localeCompare(b));
}

const out = path.join(config.repoRoot, 'apps/server/assets/character-ips.json');
await writeFile(
  out,
  JSON.stringify({
    source: `deepghs/pixai-tagger-v0.9-onnx@${REV.slice(0, 7)} selected_tags.csv`,
    license: 'Apache-2.0',
    generatedAt: new Date().toISOString(),
    characters,
  }),
);
console.log(`已生成 ${out}：${Object.keys(characters).length} 个角色`);
