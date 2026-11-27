/**
 * 生成内部点的约定（src/core/pointContracts.json，docs/plugins.md 第 7 节）：npm run points:contracts -w @emaki/server
 *
 * 约定是补丁能看到、依赖的样子，不是实现：
 * - 命令、查询（注册表）：权限范围、能不能撤销、输入的 JSON Schema、contractVersion；
 * - 对变化的反应（变更传播）：订阅哪些变化、阶段、会声明哪些变化、没有变化也跑不跑；
 * - 后台任务：执行体的样子是固定的（拿到任务上下文，返回一句话）；
 * - 口径（readmodel/terms.ts 的 TERM_POINTS）、网页的函数（patchableFn）：源码里写的参数和返回，加版本号；
 * - 网页的组件（patchable）：源码里写的 props 类型，加版本号。
 * 源码里取的都去掉注释、空白合成一个空格：只改注释、换行，约定不变。
 *
 * 不用 TypeScript 的类型检查（仓库用的 TypeScript 7 没有 JS 的接口），取的是源码里写出来的类型（引用的类型按名字，不展开）。
 * test/architecture/pointContracts.test.ts 现场再生成一遍，和提交的那份不一样就失败。
 */
import { TERM_POINTS } from '../src/readmodel/terms.ts';
import { WEB_POINTS } from '@emaki/shared';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EventBus } from '../src/core/events.ts';
import { CONTRACTS_FILE, type PointContracts } from '../src/core/pointContracts.ts';
import { SqliteDataSource } from '../src/datasource/sqlite/SqliteDataSource.ts';

const SERVER_SRC = fileURLToPath(new URL('../src/', import.meta.url));
const WEB_SRC = fileURLToPath(new URL('../../web/src/', import.meta.url));

export async function generatePointContracts(): Promise<PointContracts> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'emaki-contracts-'));
  const log = console.log;
  console.log = () => {};
  let ds: SqliteDataSource;
  try {
    ds = await SqliteDataSource.open(new EventBus(), dir, { memory: true, autoJobs: false, importDict: false });
  } finally {
    console.log = log;
  }
  try {
    const out: PointContracts = {};
    const reactions = new Map(ds.ctx.propagation.list().map((r) => [r.name, r]));
    const terms = termSources();
    for (const p of ds.ctx.points.list().sort((a, b) => a.name.localeCompare(b.name))) {
      const local = p.name.slice(p.name.indexOf(':') + 1);
      if (p.kind === 'command' || p.kind === 'query') {
        const d = ds.registry.get(local)!;
        const schema = z.toJSONSchema(d.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
        delete schema.$schema;
        out[p.name] = [
          `scope: ${d.scope}`,
          ...(d.kind === 'command' ? [`undoable: ${d.undoable}`] : []),
          `input: ${JSON.stringify(schema)}`,
          ...(d.contractVersion ? [`version: ${d.contractVersion}`] : []),
        ];
      } else if (p.kind === 'reaction') {
        const r = reactions.get(local)!;
        out[p.name] = [`phase: ${r.phase}`, `on: ${r.on.join(', ')}`, ...(r.emits?.length ? [`emits: ${r.emits.join(', ')}`] : []), ...(r.always ? ['always: true'] : [])];
      } else if (p.kind === 'job') {
        out[p.name] = ['run: (任务上下文) => 一句话 | 没有'];
      } else if (p.kind === 'term') {
        const t = TERM_POINTS.find((x) => x.name === p.name)!;
        out[p.name] = [`signature: ${terms.get(p.name) ?? '?'}`, `version: ${t.version}`];
      } else {
        const w = WEB_POINTS.find((x) => x.name === p.name)!;
        out[p.name] = [...webContract(w.name, w.file), `version: ${w.version}`];
      }
    }
    return out;
  } finally {
    await ds.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 口径的签名：TERM_POINTS 里每一项的 base 指向的 export const 函数 */
function termSources(): Map<string, string> {
  const text = stripComments(readFileSync(path.join(SERVER_SRC, 'readmodel', 'terms.ts'), 'utf8'));
  const list = text.slice(text.indexOf('TERM_POINTS'));
  const bases = [...list.slice(0, list.indexOf(']')).matchAll(/base:\s*(\w+)/g)].map((m) => m[1]!);
  return new Map(TERM_POINTS.map((t, i) => [t.name, functionSignature(text, bases[i]!)]));
}

/** 网页的点：patchable('component:…', 组件) 取组件的 props 类型；patchableFn('fn:…', 函数) 取函数的参数和返回 */
function webContract(name: string, file: string): string[] {
  const text = stripComments(readFileSync(path.join(WEB_SRC, ...file.split('/')), 'utf8'));
  const call = new RegExp(`patchable(?:Fn)?\\(\\s*'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*,\\s*`).exec(text);
  if (!call) throw new Error(`${file} 里没有登记 ${name}`);
  const at = call.index + call[0].length;
  const ident = /^[A-Za-z_$][\w$]*/.exec(text.slice(at))?.[0];
  if (name.startsWith('component:')) {
    if (!ident) throw new Error(`${name}：patchable 的第二个参数要是组件的名字`);
    return [`props: ${componentProps(text, ident)}`];
  }
  // 函数：直接写在 patchableFn 里的箭头函数，或者一个名字
  return [`signature: ${ident ? functionSignature(text, ident) : arrowSignature(text, at)}`];
}

/** function X(参数) 的第一个参数的类型（props） */
export function componentProps(text: string, ident: string): string {
  const m = new RegExp(`function\\s+${ident}\\s*\\(`).exec(text);
  if (!m) throw new Error(`找不到组件 ${ident}`);
  const open = m.index + m[0].length - 1;
  const params = text.slice(open + 1, matching(text, open));
  const first = splitTop(params, ',')[0] ?? '';
  const colon = indexTop(first, ':');
  return colon < 0 ? '(没写)' : squash(first.slice(colon + 1));
}

/** const X = (…) => / function X(…): 的参数和返回 */
export function functionSignature(text: string, ident: string): string {
  const fn = new RegExp(`function\\s+${ident}\\s*\\(`).exec(text);
  if (fn) {
    const open = fn.index + fn[0].length - 1;
    const close = matching(text, open);
    const body = text.indexOf('{', close);
    return squash(text.slice(open, body));
  }
  const c = new RegExp(`const\\s+${ident}\\s*(?::[^=]+)?=\\s*`).exec(text);
  if (!c) throw new Error(`找不到函数 ${ident}`);
  return arrowSignature(text, c.index + c[0].length);
}

/** 从箭头函数的开头取到 => 之前 */
function arrowSignature(text: string, at: number): string {
  const open = text.indexOf('(', at);
  const close = matching(text, open);
  return squash(text.slice(open, text.indexOf('=>', close)));
}

/** 去掉注释（跳过字符串） */
export function stripComments(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out;
}

/** 括号配对（( [ {，跳过字符串） */
function matching(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      i = j;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return i;
  }
  throw new Error('括号没配上');
}

/** 第一层（不在括号、字符串里）的某个字符的位置 */
function indexTop(s: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      i = j;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

function splitTop(s: string, ch: string): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = indexTop(rest, ch); i >= 0; i = indexTop(rest, ch)) {
    out.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  out.push(rest);
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export function writePointContracts(c: PointContracts): void {
  writeFileSync(CONTRACTS_FILE, `${JSON.stringify(c, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const c = await generatePointContracts();
  writePointContracts(c);
  console.log(`已写好 ${Object.keys(c).length} 个内部点的约定：${fileURLToPath(CONTRACTS_FILE)}`);
}
