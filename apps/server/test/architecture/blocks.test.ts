/**
 * 页面区块只走公开的查询（P5，docs/core-architecture.md 第 10 节）。
 *
 * 网页的区块注册表（apps/web/src/blocks/registry.ts）给每个页面区块登记了稳定 id 和它用到的查询。这里核对：
 * - id 唯一、格式是「页面.区块」，每页至少一个区块；
 * - 登记的每个查询都是服务端真实存在的 GET 接口（从 src/app.ts、src/routes/*.ts 扫出来），或者 SSE 事件；
 * - 区块用的页面组件确实按注册表渲染（页面文件里有 <PageBlocks page="…">，并且给每个区块都写了渲染函数）。
 * 以后的个性化页面、插件按区块 id 引用，查询必须是公开接口，页面里不藏业务规则。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_BLOCKS, PAGES, blocksOf, type PageId } from '../../../web/src/blocks/registry.ts';
import { stripComments } from './sqlWrites.ts';

const SRC = path.resolve(import.meta.dirname, '../../src');
const WEB = path.resolve(import.meta.dirname, '../../../web/src');

/** 服务端声明的 GET 路由（和 http.smoke.test.ts 的扫描同一个写法） */
function declaredGets(): Set<string> {
  const out = new Set<string>();
  const files = [path.join(SRC, 'app.ts'), ...readdirSync(path.join(SRC, 'routes')).map((f) => path.join(SRC, 'routes', f))];
  for (const f of files) {
    const text = stripComments(readFileSync(f, 'utf8'), f);
    for (const m of text.matchAll(/\bapp\.get\(\s*'([^']+)'/g)) out.add(`GET ${m[1]}`);
  }
  return out;
}

/** 网页源码里所有文件（找 PageBlocks 的用法） */
function webFiles(dir = WEB): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? webFiles(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) && !/\.test\./.test(d.name) ? [path.join(dir, d.name)] : [],
  );
}

describe('页面区块（apps/web/src/blocks/registry.ts）', () => {
  it('区块 id 唯一、按「页面.区块」命名', () => {
    const ids = ALL_BLOCKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [page, def] of Object.entries(PAGES)) {
      expect(def.blocks.length, page).toBeGreaterThan(0);
      for (const b of def.blocks) expect(b.id.startsWith(`${page}.`), b.id).toBe(true);
    }
  });

  it('稳定 id：以后的个人布局按它们存，改名要连同布局迁移一起做', () => {
    expect(Object.fromEntries(Object.entries(PAGES).map(([p, d]) => [p, d.blocks.map((b) => b.id)]))).toEqual({
      home: ['home.import', 'home.stats', 'home.daily', 'home.triage', 'home.recent', 'home.latest', 'home.annex'],
      characters: ['characters.top', 'characters.recent', 'characters.works', 'characters.list'],
      character: ['character.hero', 'character.related', 'character.collections', 'character.images'],
      work: ['work.hero', 'work.characters', 'work.collections', 'work.images'],
      collection: ['collection.head', 'collection.cast', 'collection.contents'],
      group: ['group.head', 'group.cast', 'group.contents'],
    });
  });

  it('区块只走公开的查询：登记的都是服务端真实存在的 GET 接口或 SSE 事件', () => {
    const gets = declaredGets();
    expect(gets.has('GET /api/summary')).toBe(true);
    const bad = ALL_BLOCKS.flatMap((b) => b.queries.filter((q) => !(q.startsWith('SSE ') || gets.has(q))).map((q) => `${b.id}: ${q}`));
    expect(bad).toEqual([]);
  });

  it('页面按注册表渲染：每页都有 <PageBlocks page=…>，每个区块都给了渲染函数', () => {
    // TSX 里有 JSX，单一写入者的词法扫不了；直接找 <PageBlocks … page="…"> 这个标签
    const sources = webFiles().map((f) => readFileSync(f, 'utf8'));
    const pagesIn = (s: string) => new Set([...s.matchAll(/<PageBlocks\s[^>]*?page="(\w+)"/g)].map((m) => m[1]));
    for (const page of Object.keys(PAGES) as PageId[]) {
      const users = sources.filter((s) => pagesIn(s).has(page));
      expect(users.length, `${page} 页没有用 PageBlocks 渲染`).toBeGreaterThan(0);
      const text = users.join('\n');
      for (const b of PAGES[page].blocks) expect(text.includes(`'${b.id}'`), `${b.id} 没有渲染函数`).toBe(true);
    }
    // 同一页按区域分开排（角色总览：作用域淡入里的 Top，视图淡入里的总览 / 列表）
    expect(blocksOf('characters', 'scope').map((b) => b.id)).toEqual(['characters.top']);
    expect(blocksOf('characters', 'overview').map((b) => b.id)).toEqual(['characters.recent', 'characters.works']);
    expect(blocksOf('home').map((b) => b.id)[0]).toBe('home.import');
  });
});
