// 把 data.json（数字）和 story.json（Claude 写的文字，可以没有）填进模板，生成 out/report.html
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { args, readJson, SKILL_DIR } from './lib.mjs';

const { out } = args();
const D = readJson(path.join(out, 'data.json'));
if (!D) throw new Error('没有 data.json，先运行 analyze.mjs');
const S = readJson(path.join(out, 'story.json'), {}) ?? {};
// </script> 不能出现在内联脚本里
const json = (v) => JSON.stringify(v).replace(/<\//g, '<\\/');
const html = readFileSync(path.join(SKILL_DIR, 'template.html'), 'utf8')
  .replace('/*DATA*/ null', () => json(D))
  .replace('/*STORY*/ null', () => json(S));
const f = path.join(out, 'report.html');
writeFileSync(f, html);
console.log(`报告：${f}${Object.keys(S).length ? '' : '（还没有 story.json，只有图表）'}`);
