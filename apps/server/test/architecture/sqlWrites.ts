/**
 * 单一写入者检查用的源码扫描器（P0，docs/core-architecture.md 第 12 节）。
 *
 * 做法：把每个源文件切成词法单元，只看字符串字面量（单引号、双引号、模板字符串，含多行；
 * 模板里的 `${…}` 换成占位符），在里面找 SQL 写入：INSERT [OR …] INTO、REPLACE INTO、UPDATE [OR …] … SET、DELETE FROM。
 * 注释里的 SQL 不算；写在字符串里但没执行的 SQL 也算（宁可多报，不漏报）。
 *
 * 另外两类也算写入：
 * - 撤销记录器的快照：`u.columns('表', …)`、`u.set('表', …)`、`u.inserted('表', …)`，撤销时会改回这张表；
 *   `u.sql('…')` 的逆操作本身是字符串，按上面的 SQL 规则识别。
 * - 表名是 `${…}` 拼出来的（撤销回放、按参数选表的工具函数）：记成 `<dynamic>`。
 *
 * images 表按列组分给不同的主人（第 2.4 节）：UPDATE 会解析 SET 子句里的列名，记成 `images#<列组>`；
 * 列名拼出来、整行快照这类看不出列的，记成 `images#?`。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 表名是拼出来的 */
export const DYNAMIC_TABLE = '<dynamic>';

export interface SqlWrite {
  /** 相对 apps/server/src，正斜杠 */
  file: string;
  /** 表名；images 带列组后缀；拼出来的表名是 DYNAMIC_TABLE */
  table: string;
  line: number;
  /** 命中的那一小段，报错时给人看 */
  snippet: string;
}

/** 模板字符串里 `${…}` 的占位符（不会出现在正常 SQL 里） */
const HOLE = '\u0001';

interface StringToken {
  text: string;
  line: number;
  /** 这个字面量在源码里的起点（用来找它前面的调用） */
  start: number;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await',
]);

/**
 * 简单的 TS / JS 词法：跳过注释和正则字面量，收集字符串字面量。
 * 读不懂的文件（字符串没结束等）直接抛错，让测试失败，而不是悄悄漏掉。
 */
export function extractStrings(src: string, file = '<src>'): StringToken[] {
  return tokenize(src, file).strings;
}

/** 把注释换成空格（换行保留，行号不变），其余原样：按调用点扫描时不把注释里提到的名字算进去 */
export function stripComments(src: string, file = '<src>'): string {
  const units = src.split('');
  for (const [a, b] of tokenize(src, file).comments) for (let k = a; k < b; k++) if (units[k] !== '\n') units[k] = ' ';
  return units.join('');
}

/** 词法结果：字符串字面量，以及注释的位置（[起点, 终点)） */
function tokenize(src: string, file: string): { strings: StringToken[]; comments: [number, number][] } {
  const out: StringToken[] = [];
  const comments: [number, number][] = [];
  let i = 0;
  let line = 1;
  // 上一个有意义的字符 / 标识符：判断 `/` 是除号还是正则
  let prevSig = '';
  let prevWord = '';
  // 模板嵌套：每层记下 `${` 里的花括号深度
  const templateStack: { depth: number; parts: string[]; line: number; start: number }[] = [];
  let braceDepth = 0;

  const fail = (msg: string): never => {
    throw new Error(`${file}:${line} 扫描失败：${msg}`);
  };

  const readQuoted = (q: string): string => {
    const startLine = line;
    let s = '';
    i++;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '\\') {
        const next = src[i + 1] ?? '';
        if (next === '\n') line++;
        s += escapeChar(next);
        i += 2;
        continue;
      }
      if (ch === q) {
        i++;
        return s;
      }
      if (ch === '\n') fail(`第 ${startLine} 行的字符串没有结束`);
      s += ch;
      i++;
    }
    return fail(`第 ${startLine} 行的字符串没有结束`);
  };

  /** 读模板的一段文字，停在结尾的 ` 或 `${` 之后 */
  const readTemplateChunk = (): 'end' | 'hole' => {
    const top = templateStack[templateStack.length - 1]!;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '\\') {
        const next = src[i + 1] ?? '';
        if (next === '\n') line++;
        top.parts.push(escapeChar(next));
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        return 'end';
      }
      if (ch === '$' && src[i + 1] === '{') {
        i += 2;
        top.parts.push(HOLE);
        return 'hole';
      }
      if (ch === '\n') line++;
      top.parts.push(ch);
      i++;
    }
    return fail('模板字符串没有结束');
  };

  const startTemplate = () => {
    templateStack.push({ depth: 0, parts: [], line, start: i });
    i++;
    continueTemplate();
  };

  const continueTemplate = () => {
    const r = readTemplateChunk();
    if (r === 'end') {
      const t = templateStack.pop()!;
      out.push({ text: t.parts.join(''), line: t.line, start: t.start });
      prevSig = '`';
      prevWord = '';
    } else {
      templateStack[templateStack.length - 1]!.depth = braceDepth;
      braceDepth++;
      prevSig = '{';
      prevWord = '';
    }
  };

  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1] ?? '';
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const from = i;
      while (i < src.length && src[i] !== '\n') i++;
      comments.push([from, i]);
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('块注释没有结束');
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      comments.push([i, end + 2]);
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const startLine = line;
      const start = i;
      const text = readQuoted(ch);
      out.push({ text, line: startLine, start });
      prevSig = ch;
      prevWord = '';
      continue;
    }
    if (ch === '`') {
      startTemplate();
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      prevSig = ch;
      prevWord = '';
      i++;
      continue;
    }
    if (ch === '}') {
      const top = templateStack[templateStack.length - 1];
      if (top && braceDepth - 1 === top.depth) {
        // 模板里的 `${…}` 结束，接着读模板文字
        braceDepth--;
        i++;
        continueTemplate();
        continue;
      }
      braceDepth--;
      prevSig = ch;
      prevWord = '';
      i++;
      continue;
    }
    if (ch === '/') {
      const regexAllowed = prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || REGEX_PREFIX_KEYWORDS.has(prevWord);
      if (regexAllowed) {
        // 正则字面量：跳到结尾的 /（字符类里的 / 不算）
        i++;
        let inClass = false;
        while (i < src.length) {
          const c = src[i]!;
          if (c === '\\') {
            i += 2;
            continue;
          }
          if (c === '\n') fail('正则字面量没有结束');
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          i++;
        }
        i++;
        while (i < src.length && /[a-z]/i.test(src[i]!)) i++;
        prevSig = ')';
        prevWord = '';
        continue;
      }
      prevSig = ch;
      prevWord = '';
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      prevWord = src.slice(i, j);
      prevSig = 'a';
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      while (i < src.length && /[\w.]/.test(src[i]!)) i++;
      prevSig = '0';
      prevWord = '';
      continue;
    }
    // TS 的非空断言 x! / a[i]! / f()!：后面的 / 是除号
    const postfixBang = ch === '!' && next !== '=' && /[a0)\]`'"]/.test(prevSig) && !REGEX_PREFIX_KEYWORDS.has(prevWord);
    prevSig = postfixBang ? ')' : ch;
    prevWord = '';
    i++;
  }
  if (templateStack.length) fail('模板字符串没有结束');
  return { strings: out, comments };
}

function escapeChar(c: string): string {
  if (c === 'n') return '\n';
  if (c === 't') return '\t';
  if (c === '\n') return '';
  return c;
}

// ---------------------------------------------------------------- images 的列组

/** images 表的列 → 列组（第 2.4 节的模块）；新列必须在这里登记，否则测试失败 */
export const IMAGE_COLUMN_GROUPS: Record<string, string> = {
  // 图库与文件：文件系统上的观测
  id: 'library',
  root_id: 'library',
  rel_path: 'library',
  file_name: 'library',
  width: 'library',
  height: 'library',
  bytes: 'library',
  format: 'library',
  sha256: 'library',
  added_at: 'library',
  modified_at: 'library',
  missing: 'library',
  trashed_at: 'library',
  // 分析：可以重算的派生数据
  dhash: 'analysis',
  dominant_color: 'analysis',
  thumb_at: 'analysis',
  decode_error: 'analysis',
  content_kind: 'analysis',
  content_kind_source: 'analysis',
  content_kind_evidence: 'analysis',
  content_kind_version: 'analysis',
  camera: 'analysis',
  kind_signals: 'analysis',
  theme: 'analysis',
  art_score: 'analysis',
  frame_count: 'analysis',
  // 证据：识别进度和文件名解析出的来源
  tagged_at: 'evidence',
  tagger_model: 'evidence',
  retag: 'evidence',
  artist_checked_at: 'evidence',
  source_site: 'evidence',
  source_post_id: 'evidence',
  source_artist: 'evidence',
  source_url: 'evidence',
  // 归类：用户或规则做的决定
  rating: 'curation',
  rating_manual: 'curation',
  favorite: 'curation',
  shelved_at: 'curation',
  original_at: 'curation',
  content_kind_manual: 'curation',
  artist_manual: 'curation',
  source_manual: 'curation',
  // 可见性：排除结果和单张例外
  excluded_by: 'visibility',
  exclude_exempt: 'visibility',
  // 合集：成员和页码
  collection_id: 'collections',
  page_no: 'collections',
  collection_detached: 'collections',
};

const imageKey = (cols: string[] | null): string[] => {
  if (cols === null) return ['images#?'];
  const groups = new Set<string>();
  for (const c of cols) groups.add(IMAGE_COLUMN_GROUPS[c] ? `images#${IMAGE_COLUMN_GROUPS[c]}` : `images#未登记列:${c}`);
  return [...groups];
};

/** SET 子句里的列名；看不出来（列名是拼的）返回 null */
function setColumns(afterSet: string): string[] | null {
  // 截到 WHERE / FROM / RETURNING / 语句结束（只看括号外）
  let depth = 0;
  let end = afterSet.length;
  for (let k = 0; k < afterSet.length; k++) {
    const c = afterSet[k]!;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) {
        end = k;
        break;
      }
      depth--;
    } else if (c === ';' && depth === 0) {
      end = k;
      break;
    } else if (depth === 0 && /\s/.test(c) && /^\s+(WHERE|FROM|RETURNING|ORDER|LIMIT)\b/i.test(afterSet.slice(k))) {
      end = k;
      break;
    }
  }
  const clause = afterSet.slice(0, end);
  const parts: string[] = [];
  depth = 0;
  let cur = '';
  for (const c of clause) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  const cols: string[] = [];
  for (const p of parts) {
    const lhs = p.split('=')[0]!.trim();
    if (!lhs || lhs.includes(HOLE)) return null;
    // (a, b) = (…) 这种行值赋值
    const names = lhs.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim());
    for (const n of names) {
      if (!/^[A-Za-z_]\w*$/.test(n)) return null;
      cols.push(n.toLowerCase());
    }
  }
  return cols.length ? cols : null;
}

// ---------------------------------------------------------------- SQL 写入

const NAME = String.raw`(${HOLE}|"?[A-Za-z_][\w]*"?)`;
const WRITE_RES: { re: RegExp; kind: 'insert' | 'update' | 'delete' }[] = [
  { re: new RegExp(String.raw`\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+(?:main\.)?${NAME}`, 'gi'), kind: 'insert' },
  { re: new RegExp(String.raw`\bDELETE\s+FROM\s+(?:main\.)?${NAME}`, 'gi'), kind: 'delete' },
  // UPDATE 表 [AS 别名] SET；ON CONFLICT … DO UPDATE SET 后面直接是 SET，不会匹配
  { re: new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?(?:main\.)?${NAME}(?:\s+(?:AS\s+)?\w+)?\s+SET\b`, 'gi'), kind: 'update' },
];

/** 一段字符串里的 SQL 写入：返回表名（images 带列组） */
export function sqlWritesIn(text: string): { table: string; snippet: string }[] {
  const out: { table: string; snippet: string }[] = [];
  for (const { re, kind } of WRITE_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      let name = m[1]!.replace(/"/g, '');
      if (name.toUpperCase() === 'SET' && kind === 'update') continue;
      const snippet = text.slice(m.index, m.index + 80).replace(/\s+/g, ' ').replaceAll(HOLE, '${…}');
      if (name === HOLE) {
        out.push({ table: DYNAMIC_TABLE, snippet });
        continue;
      }
      name = name.toLowerCase();
      if (name === 'images') {
        if (kind === 'update') {
          const after = text.slice(m.index + m[0].length);
          for (const t of imageKey(setColumns(after))) out.push({ table: t, snippet });
          continue;
        }
        // 新增和删除整行：图库与文件
        out.push({ table: 'images#library', snippet });
        continue;
      }
      out.push({ table: name, snippet });
    }
  }
  return out;
}

/** 撤销记录器的快照调用：u.columns('表', [列…])、u.set('表', …)、u.inserted('表', …) */
const RECORDER_RE = /\.\s*(columns|set|inserted)\s*\(\s*$/;

function recorderWrite(src: string, tok: StringToken, tables: ReadonlySet<string>, nextChars: string): string[] | null {
  const before = src.slice(Math.max(0, tok.start - 60), tok.start);
  const m = RECORDER_RE.exec(before);
  if (!m) return null;
  const table = tok.text;
  // Map.set('key', …) 之类：只认真实存在的表名
  if (!tables.has(table)) return null;
  if (table !== 'images') return [table];
  if (m[1] === 'columns') {
    // 第二个参数是字面量数组时解析列名；是变量就看不出来
    const arr = /^\s*,\s*\[([^\]]*)\]/.exec(nextChars);
    if (!arr) return ['images#?'];
    const cols = [...arr[1]!.matchAll(/['"](\w+)['"]/g)].map((x) => x[1]!);
    if (/\.\.\.|[A-Za-z_]\w*\s*(?:[,\]]|$)/.test(arr[1]!.replace(/['"]\w+['"]/g, ''))) return ['images#?'];
    return imageKey(cols);
  }
  return ['images#?'];
}

/** 撤销记录器的表名是变量（u.set(table, …)）：看不出是哪张表。只认记录器常用的变量名，免得把 Map.set(key, …) 算进来 */
const RECORDER_VAR_RE = /\b(?:u|undo|rec|recorder)\s*\.\s*(?:columns|set|inserted)\s*\(\s*[A-Za-z_$]/g;

/** 扫描一个文件 */
export function scanSource(src: string, file: string, tables: ReadonlySet<string>): SqlWrite[] {
  const out: SqlWrite[] = [];
  const { strings, comments } = tokenize(src, file);
  // 注释换成空格（保留换行），再找表名是变量的撤销快照
  let code = src;
  for (const [a, b] of comments) code = code.slice(0, a) + src.slice(a, b).replace(/[^\n]/g, ' ') + code.slice(b);
  for (const m of code.matchAll(RECORDER_VAR_RE)) {
    const line = code.slice(0, m.index).split('\n').length;
    out.push({ file, table: DYNAMIC_TABLE, line, snippet: `撤销快照 ${code.slice(m.index, m.index + 60).split('\n')[0]}` });
  }
  for (const tok of strings) {
    for (const w of sqlWritesIn(tok.text)) out.push({ file, table: w.table, line: tok.line, snippet: w.snippet });
    const after = tokenEnd(src, tok.start);
    const rec = recorderWrite(src, tok, tables, src.slice(after, after + 400));
    if (rec) for (const t of rec) out.push({ file, table: t, line: tok.line, snippet: `撤销快照 ${tok.text}` });
  }
  return out;
}

/** 字符串字面量（单 / 双引号）结束后的位置；只用于撤销记录器的表名参数 */
function tokenEnd(src: string, start: number): number {
  const q = src[start]!;
  if (q !== "'" && q !== '"') return start;
  let k = start + 1;
  while (k < src.length && src[k] !== q) k += src[k] === '\\' ? 2 : 1;
  return k + 1;
}

/** 要扫描的源文件：src 下所有非测试的 .ts / .mts / .js / .mjs */
export function listSourceFiles(srcRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        walk(p);
      } else if (/\.(ts|mts|js|mjs)$/.test(e.name) && !/\.test\.(ts|mts|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        out.push(p);
      }
    }
  };
  walk(srcRoot);
  return out.sort();
}

/** 扫描整个 src；file 是相对 srcRoot 的路径 */
export function scanTree(srcRoot: string, tables: ReadonlySet<string>): SqlWrite[] {
  const out: SqlWrite[] = [];
  for (const abs of listSourceFiles(srcRoot)) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    out.push(...scanSource(readFileSync(abs, 'utf8'), rel, tables));
  }
  return out;
}
