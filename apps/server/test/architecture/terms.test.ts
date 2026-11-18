/**
 * 命名口径只有一份（P5，docs/core-architecture.md 第 1 节原则 5、第 6 节；附录 #24–#26）。
 *
 * 「可见」「计入统计」「插画」「待处理队列（按大类）」「待识别」「图的作品」只在 readmodel/terms.ts 里定义（SQL 片段或视图）。
 * 这里扫描 apps/server/src 的非测试源码里所有字符串字面量（含模板字符串，`${…}` 换成占位符，注释不算），
 * 在口径模块之外发现这些条件的内联写法就失败（和单一写入者测试一个风格）：以前「可见」在约 10 个文件里抄了约 15 次，
 * 队列条件有 5 个变体，改一处就漏另一处。
 *
 * 要用这些条件：从 readmodel/terms.ts 引用（VISIBLE、COUNTED、FILE_LIVE、ROOT_ACTIVE、QUEUE、ART_SCOPE……），或者直接用视图
 * （v_images、v_counted_images、v_illust_images、v_image_works）。确实是另一个概念（例如写入时的状态切换）就在 ALLOWED 里写清楚原因。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as terms from '../../src/readmodel/terms.ts';
import { extractStrings, listSourceFiles } from './sqlWrites.ts';

const SRC = path.resolve(import.meta.dirname, '../../src');
/** 口径的唯一定义 */
const HOME = 'readmodel/terms.ts';

interface Rule {
  name: string;
  /** 一个字符串字面量里出现这样的写法就算内联抄写 */
  test: (sql: string) => boolean;
  use: string;
}

const has = (re: RegExp) => (s: string) => re.test(s);

const RULES: Rule[] = [
  {
    name: '可见 / 文件在（missing = 0 和 trashed_at IS NULL 一起当条件）',
    // SET 里的 `missing = 0,` 是写入，不算
    test: (s) => /\bmissing\s*=\s*0\b(?!\s*,)/i.test(s) && /\btrashed_at\s+IS\s+NULL\b/i.test(s),
    use: 'VISIBLE / LIVE_IMAGES / COUNTED / FILE_LIVE，或者视图 v_images、v_counted_images',
  },
  {
    name: '图库文件夹可见（enabled = 1 和 removed_at IS NULL）',
    test: has(/\benabled\s*=\s*1\s+AND\s+(?:\w+\.)?removed_at\s+IS\s+NULL|\bremoved_at\s+IS\s+NULL\s+AND\s+(?:\w+\.)?enabled\s*=\s*1/i),
    use: 'ROOT_ACTIVE / ACTIVE_ROOT_IDS',
  },
  {
    name: '有没有角色（EXISTS image_characters … = i.id）',
    test: has(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+image_characters\s+\w+\s+WHERE\s+\w+\.image_id\s*=\s*\w+\.id\s*\)/i),
    use: 'HAS_CHARACTER / NO_CHARACTER / UNRECOGNIZED',
  },
  {
    name: '整本处理的合集（kind <> group 且 active）',
    test: (s) => /\bkind\s*<>\s*'group'/i.test(s) && /\bstate\s*=\s*'active'/i.test(s),
    use: 'NOT_IN_BOOK',
  },
  {
    name: '「未识别里也列出漫画页」的设置',
    test: has(/comicInUnrecognized/),
    use: 'COMIC_IN_QUEUE / QUEUE_KINDS_SQL',
  },
  {
    name: '要找角色的类型 / 别册的类型（content_kind IN (…)）',
    test: has(/content_kind\s+(?:NOT\s+)?IN\s*\(\s*'(?:illustration|comic|screenshot|text|photo|meme)'/i),
    use: 'ART_KINDS_SQL / ANNEX_KINDS_SQL / QUEUE_KINDS_SQL',
  },
  {
    name: '插画（content_kind = / <> illustration）',
    test: has(/content_kind\s*(?:=|<>|!=)\s*'illustration'/i),
    use: 'ILLUSTRATION，或者视图 v_illust_images',
  },
  {
    name: '待识别（tagged_at IS NULL 且不是漫画 / 跳过相机照片）',
    test: (s) => /tagged_at\s+IS\s+NULL\s+AND\s+(?:\w+\.)?content_kind\s*<>\s*'comic'/i.test(s) || /@skipCamera\b/.test(s),
    use: 'UNTAGGED_UNRECOGNIZED / TAGGABLE / TAG_PENDING',
  },
  {
    name: '图的作品（关联角色的作品和手动指定的作品拼在一起）',
    // 「作品还有没有人用」这种只看引用、不经过图的检查不算
    test: (s) => /\bimage_copyrights\b/.test(s) && /\bcharacter_works\b/.test(s) && /\bimage_characters\b/.test(s),
    use: '视图 v_image_works，或者 imageWorkRows / WORK_HAS_ILLUSTRATION',
  },
  {
    name: '敏感分级（rating IN (questionable, explicit)）',
    test: has(/rating\s+IN\s*\(\s*'questionable'\s*,\s*'explicit'\s*\)/i),
    use: 'SENSITIVE_SQL（和前端的 SENSITIVE_RATINGS 同一份）',
  },
];

/**
 * 允许清单：「文件 | 规则名」→ 原因。只许变短（清单里的项不再出现也会失败）。
 * 这些是同样的写法、但不是这条口径（例如写入时的状态切换、只看文件本身的维护任务）
 */
const ALLOWED: Record<string, string> = {};

interface Hit {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const abs of listSourceFiles(SRC)) {
    const file = path.relative(SRC, abs).split(path.sep).join('/');
    if (file === HOME) continue;
    for (const s of extractStrings(readFileSync(abs, 'utf8'), file)) {
      for (const r of RULES) if (r.test(s.text)) hits.push({ file, line: s.line, rule: r.name, snippet: s.text.replace(/\s+/g, ' ').trim().slice(0, 140) });
    }
  }
  return hits;
}

describe('命名口径只有一份（readmodel/terms.ts）', () => {
  const hits = scan();

  it.each(RULES.map((r) => [r.name, r] as const))('%s', (name, rule) => {
    const bad = hits.filter((h) => h.rule === name && !ALLOWED[`${h.file} | ${name}`]).map((h) => `${h.file}:${h.line} ${h.snippet}`);
    expect(bad, `不要内联抄写口径，从 ${HOME} 引用：${rule.use}`).toEqual([]);
  });

  it('允许清单只许变短', () => {
    const seen = new Set(hits.map((h) => `${h.file} | ${h.rule}`));
    expect(Object.keys(ALLOWED).filter((k) => !seen.has(k)), '这些例外已经不在了，从 ALLOWED 里删掉').toEqual([]);
  });

  it('扫描器认得内联写法、跳过注释，引用口径模块的不算', () => {
    const of = (src: string) => extractStrings(src, 'x.ts').flatMap((s) => RULES.filter((r) => r.test(s.text)).map((r) => r.name));
    expect(of("db.prepare('SELECT 1 FROM images i WHERE i.missing = 0 AND i.trashed_at IS NULL')")).toHaveLength(1);
    expect(of("db.prepare('UPDATE images SET missing = 0, trashed_at = NULL WHERE id = ?')")).toEqual([]);
    expect(of('// WHERE i.missing = 0 AND i.trashed_at IS NULL\nconst x = 1;')).toEqual([]);
    expect(of('db.prepare(`SELECT 1 FROM images i JOIN library_roots r ON r.id = i.root_id WHERE ${VISIBLE}`)')).toEqual([]);
    expect(of("const q = `SELECT id FROM library_roots WHERE enabled = 1 AND removed_at IS NULL`;")).toHaveLength(1);
    expect(of("const q = `x AND NOT EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id=i.id)`;")).toHaveLength(1);
    expect(of("const q = `EXISTS (SELECT 1 FROM image_characters ic WHERE ic.image_id = i.id AND ic.character_id = ?)`;")).toEqual([]);
  });

  it('口径模块里的字面写法保持部分索引能命中', () => {
    // 迁移 006 / 008 / 038 的部分索引：WHERE trashed_at IS NULL AND missing = 0（动图再加 animated = 1）
    for (const s of [terms.VISIBLE, terms.LIVE_IMAGES, terms.COUNTED(), terms.FILE_LIVE()]) {
      expect(s).toContain('i.missing = 0');
      expect(s).toContain('i.trashed_at IS NULL');
    }
    expect(terms.VISIBLE).toBe('i.missing = 0 AND i.trashed_at IS NULL AND r.enabled = 1 AND r.removed_at IS NULL');
    expect(terms.LIVE_IMAGES).toBe(
      'i.missing = 0 AND i.trashed_at IS NULL AND +i.root_id IN (SELECT id FROM library_roots WHERE enabled = 1 AND removed_at IS NULL)',
    );
    expect(terms.ANIMATED_SQL).toBe('i.animated = 1');
    expect(terms.ART_KINDS_SQL).toBe(`i.content_kind IN ('illustration','comic')`);
    expect(terms.ANNEX_KINDS_SQL).toBe(`i.content_kind IN ('screenshot','text','photo','meme')`);
    // 片段里不能有绑定参数（TAGGABLE 的 @skipCamera 是语句级的开关，不是索引条件）
    for (const s of [terms.VISIBLE, terms.LIVE_IMAGES, terms.QUEUE, terms.ART_QUEUE_SCOPE, terms.ART_SCOPE, terms.QUEUE_OF]) expect(s).not.toMatch(/[@?]/);
  });
});
