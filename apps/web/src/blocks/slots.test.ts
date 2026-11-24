import { BUILTIN_PLUGINS, resolvePlugins, SLOT_POINT_KEYS } from '@emaki/shared';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { slotEntries } from './Slot';
import { ALL_SLOT_ENTRIES, SLOTS, type SlotId } from './slots';

const WEB = path.resolve(import.meta.dirname, '..');
const sources = (dir = WEB): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sources(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) && !/\.test\./.test(d.name) ? [path.join(dir, d.name)] : [],
  );
const files = sources().map((f) => ({ f: path.relative(WEB, f), text: readFileSync(f, 'utf8') }));

describe('界面上的条目（blocks/slots.ts，docs/plugins.md 9.2，E3）', () => {
  it('id 唯一、按「地方.条目」命名；内置插件登记的条目都存在，而且在同一种贡献点里', () => {
    const ids = ALL_SLOT_ENTRIES.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/);
    for (const p of BUILTIN_PLUGINS)
      for (const point of SLOT_POINT_KEYS)
        for (const x of p.contributes[point] ?? []) expect([p.id, x.id, ALL_SLOT_ENTRIES.find((y) => y.id === x.id)?.point]).toEqual([p.id, x.id, point]);
  });

  it('每一处都有页面按登记来画（<Slot id="…"> 或 slotEntries）', () => {
    const used = (id: string) => files.some(({ text }) => text.includes(`id="${id}"`) || text.includes(`slotEntries('${id}'`));
    expect((Object.keys(SLOTS) as SlotId[]).filter((id) => !used(id))).toEqual([]);
  });

  it('页头的操作都走登记：<PageHeader>、<DetailHeader> 的 actions 只能是 <Slot>', () => {
    const offenders: string[] = [];
    for (const { f, text } of files)
      for (const m of text.matchAll(/<(PageHeader|DetailHeader)\b/g)) {
        const tag = text.slice(m.index, m.index + 3000);
        const end = tag.search(/\n\s*\/?>\s*\n/);
        const a = tag.indexOf('actions=');
        if (a < 0 || (end >= 0 && a > end)) continue;
        const value = tag.slice(a + 'actions='.length).trimStart();
        // DetailHeader 自己把 actions 原样交给 PageHeader；未识别在外面包了一层排版用的 div
        const ok = value.startsWith('{actions}') || /^\{\s*(?:<div[^>]*>\s*)?<Slot\b/.test(value) || /^\{\s*\w+ \? \(\s*<Slot\b/.test(value);
        if (!ok) offenders.push(`${f}:${text.slice(0, m.index).split('\n').length}`);
      }
    expect(offenders).toEqual([]);
  });

  it('停用的插件放在别处的条目不画：停用「作品」，角色总览里的「作品页」链接一起收起', () => {
    const s = resolvePlugins({
      plugins: BUILTIN_PLUGINS.map((m) => ({ manifest: m, source: 'builtin', required: !!m.required, enabled: m.id !== 'core.works', displayName: null, enabledAt: null })),
      nav: { sections: {}, visible: {} },
      overrideChoices: {},
      safeMode: false,
    });
    expect(s.disabledEntries).toEqual(['characters.workPage']);
    expect(slotEntries('page.characters.work', new Set(s.disabledEntries))).toEqual([]);
    expect(slotEntries('lightbox.toolbar', new Set(s.disabledEntries))).toEqual([
      'lightbox.slideshow',
      'lightbox.kind',
      'lightbox.assistant',
      'lightbox.info',
      'lightbox.close',
    ]);
  });
});
