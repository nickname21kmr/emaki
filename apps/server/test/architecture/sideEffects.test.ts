/**
 * 连带处理只在变更传播里（P2，docs/core-architecture.md 第 5 节、第 12 节）。
 *
 * 写操作只声明变化（ctx.changed），合集重算、排除结果、缓存失效、事件推送、撤销后的补偿这些连带处理由反应完成。
 * 这里扫描 apps/server/src 的非测试源码（注释不算），在主人模块和变更传播层（propagation/）之外直接调用这些入口就失败：
 * 以前每个调用方自己记得去调，漏一个就出 bug（附录 #17、#21、#22）。
 *
 * 新加一个写操作：在 ctx.mutate / ctx.apply 里写完，声明对应的变化；要新的连带处理，在 propagation/ 或主人模块里写反应并注册。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSourceFiles, stripComments } from './sqlWrites.ts';

const SRC = path.resolve(import.meta.dirname, '../../src');

interface Rule {
  name: string;
  pattern: RegExp;
  /** 可以调用的目录（相对 src，以 / 结尾）或文件 */
  allowed: string[];
  why: string;
}

const RULES: Rule[] = [
  { name: 'collectionsHook', pattern: /\bcollectionsHook\b/, allowed: [], why: '合集重算由反应 refreshFolderCollections / refreshAllCollections 做' },
  {
    name: '合集重算（refreshAll / refreshDirs / refreshSources）',
    pattern: /\.(refreshAll|refreshDirs|refreshSources)\(/,
    allowed: ['propagation/', 'domain/collections/'],
    why: '声明 image.* / visibility.changed / root.* 等变化，合集的反应会重算',
  },
  { name: 'refreshCollections', pattern: /\brefreshCollections\(/, allowed: [], why: '后台任务结束时由变更传播做延后的全量重算' },
  { name: 'ctx.touch', pattern: /\.touch\(\)/, allowed: [], why: '缓存失效和事件由提交后反应 invalidateCaches 按 actor 做' },
  { name: 'ctx.invalidate', pattern: /\bctx\.invalidate\(/, allowed: ['propagation/'], why: '同上：只有 invalidateCaches 让缓存失效' },
  {
    name: '排除结果（reevaluateExclusions）',
    pattern: /\breevaluateExclusions\(/,
    allowed: ['propagation/', 'domain/visibility/'],
    why: '声明 visibility.rulesChanged / curation.charactersChanged 等变化，反应重新判定',
  },
  { name: '撤销后的手工接线（onUndo / onUndoLast）', pattern: /\bonUndo(Last)?\(/, allowed: [], why: '撤销会重放原操作声明的变化，反应重算' },
  { name: '设置、文件夹监听（notifySettings / notifyRoots）', pattern: /\bnotify(Settings|Roots)\(/, allowed: [], why: '声明 settings.changed / root.* 变化' },
  {
    name: 'changed 事件（以前叫 library-changed）',
    pattern: /type:\s*'(library-)?changed'/,
    // core/jobs.ts：没接变更传播时（JobQueue 单元测试）的兜底
    allowed: ['propagation/', 'core/jobs.ts'],
    why: '事件由 invalidateCaches 按 actor 推送（后台任务节流，任务结束按任务种类推）',
  },
];

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(rule: Rule): Hit[] {
  const hits: Hit[] = [];
  for (const abs of listSourceFiles(SRC)) {
    const file = path.relative(SRC, abs).split(path.sep).join('/');
    if (rule.allowed.some((a) => (a.endsWith('/') ? file.startsWith(a) : file === a))) continue;
    const lines = stripComments(readFileSync(abs, 'utf8'), file).split('\n');
    lines.forEach((text, i) => {
      if (rule.pattern.test(text)) hits.push({ file, line: i + 1, text: text.trim().slice(0, 120) });
    });
  }
  return hits;
}

describe('连带处理只在变更传播里', () => {
  it.each(RULES.map((r) => [r.name, r] as const))('%s', (_name, rule) => {
    const hits = scan(rule).map((h) => `${h.file}:${h.line} ${h.text}`);
    expect(hits, `不要直接调用：${rule.why}`).toEqual([]);
  });

  it('扫描器认得调用、跳过注释', () => {
    const rule = RULES.find((r) => r.name === 'ctx.touch')!;
    const strip = (s: string) => stripComments(s, 'x.ts');
    expect(rule.pattern.test(strip('// ctx.touch()'))).toBe(false);
    expect(rule.pattern.test(strip('/* this.ctx.touch() */ x()'))).toBe(false);
    expect(rule.pattern.test(strip('this.ctx.touch();'))).toBe(true);
  });
});
