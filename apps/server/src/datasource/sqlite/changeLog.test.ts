/**
 * 最近的自动改动（sqlite 专属）：后台自动关联 Danbooru 标签、一轮 Pixiv 补充都记进 change_log，
 * 能撤回（撤回本身可撤销）；切换 Pixiv 投稿号识别方式只去掉投稿号真的变了的建议，切回来从缓存找回。
 */
import { searchKey } from '@emaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dumpCore } from '../../../test/helpers/dump.ts';
import { sqliteFactory, type ContractEnv } from '../../../test/contract/harness.ts';
import type { JobContext } from '../../core/jobs.ts';
import { cacheArtwork } from '../../services/pixiv/cache.ts';
import type { PixivArtwork } from '../../services/pixiv/client.ts';
import { queuePixivImages, resetPixivBackoff, syncPixivCharacters } from '../../services/pixiv/sync.ts';
import type { SqliteDataSource } from './SqliteDataSource.ts';

let env: ContractEnv;
let ds: SqliteDataSource;
beforeEach(async () => {
  env = await sqliteFactory();
  ds = env.ds as SqliteDataSource;
  resetPixivBackoff();
});
afterEach(() => env.close());
const db = () => ds.ctx.db;
const img = (id: string) => Number(env.id('image', id));
const NOW_ISO = () => new Date(env.now).toISOString();
const links = (cid: number) => db().prepare('SELECT image_id, origin FROM image_characters WHERE character_id = ? ORDER BY image_id').all(cid);
/** 词库里的名字（pixiv 匹配、自建角色对 Danbooru 都靠它） */
function name(tag: string, value: string, category = 4, extra: { zh?: string; copyright?: string } = {}) {
  db().prepare('INSERT OR IGNORE INTO tag_i18n (tag, category, zh, copyright_guess, post_count) VALUES (?, ?, ?, ?, 5000)').run(tag, category, extra.zh ?? null, extra.copyright ?? null);
  db().prepare("UPDATE tag_i18n SET aliases = json_insert(COALESCE(aliases, '[]'), '$[#]', ?) WHERE tag = ?").run(value, tag);
  db().prepare('INSERT OR IGNORE INTO tag_name_keys (search_key, tag, kind, source) VALUES (?, ?, ?, ?)').run(searchKey(value), tag, extra.zh ? 'zh' : 'alias', 'dict');
}
const job = (): JobContext => ({ signal: new AbortController().signal, setTotal: vi.fn(), advance: vi.fn(), setMessage: vi.fn(), shouldYield: () => false, requeue: vi.fn(), yielded: false });
const art = (id: string, tags: string[], extra: Partial<PixivArtwork> = {}): PixivArtwork => ({ id, pageCount: 1, tags: { tags: tags.map((tag) => ({ tag })) }, ...extra });

describe('自动关联 Danbooru 标签', () => {
  it('每个自动绑定记一条，撤回解绑并去掉之后自动归进来的图（手动的不动、记成不要），以后不再自动绑；撤回可撤销', async () => {
    name('hoshino_(blue_archive)', '小鸟游星野', 4, { zh: '小鸟游星野', copyright: 'blue_archive' });
    const cid = Number(db().prepare("INSERT INTO characters (name, source, created_at) VALUES ('小鸟游星野', 'custom', ?)").run(NOW_ISO()).lastInsertRowid);
    db().prepare('INSERT INTO character_works (character_id, work_id) VALUES (?, ?)').run(cid, Number(env.id('work', 'w1')));
    db().prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (?, ?, 'manual', 'x')").run(img('i30'), cid);
    (ds as unknown as { characters: { associateAutomatic(): void } }).characters.associateAutomatic();
    expect(db().prepare('SELECT danbooru_tag, source FROM characters WHERE id = ?').get(cid)).toEqual({ danbooru_tag: 'hoshino_(blue_archive)', source: 'danbooru' });
    expect(env.events.filter((e) => e.type === 'auto-change')).toEqual([
      { type: 'auto-change', change: expect.objectContaining({ kind: 'auto-associate', summary: '「小鸟游星野」自动绑上了 Danbooru 标签 hoshino_(blue_archive)' }) },
    ]);
    // 绑定之后识别器按这个标签归进来一张
    db().prepare("INSERT INTO image_characters (image_id, character_id, origin, added_at) VALUES (?, ?, 'tagger', ?)").run(img('i27'), cid, NOW_ISO());
    const [entry] = await ds.listChanges('auto');
    expect(entry).toMatchObject({ kind: 'auto-associate', count: 1, revertable: true, revertedAt: null });
    expect(entry!.revertHint).toContain('去掉之后经这个标签自动归进来的 1 张图');
    const before = dumpCore(db());

    const r = await ds.revertChange(entry!.id);
    expect(r.message).toBe('已撤回自动关联：「小鸟游星野」不再绑 hoshino_(blue_archive)，去掉了 1 张自动归进来的图');
    expect(db().prepare('SELECT danbooru_tag, source FROM characters WHERE id = ?').get(cid)).toEqual({ danbooru_tag: null, source: 'custom' });
    expect(links(cid)).toEqual([{ image_id: img('i30'), origin: 'manual' }]);
    expect(db().prepare('SELECT image_id FROM character_vetoes WHERE character_id = ?').pluck().all(cid)).toEqual([img('i27')]);
    expect(db().prepare('SELECT danbooru_tag, dismissed FROM custom_character_matches WHERE character_id = ?').get(cid)).toEqual({ danbooru_tag: 'hoshino_(blue_archive)', dismissed: 1 });
    expect((await ds.listChanges('auto'))[0]).toMatchObject({ revertable: false, revertedAt: NOW_ISO() });
    await expect(ds.revertChange(entry!.id)).rejects.toThrow('已经撤回');
    // 再跑自动关联不会绑回去
    (ds as unknown as { characters: { associateAutomatic(): void } }).characters.associateAutomatic();
    expect(db().prepare('SELECT danbooru_tag FROM characters WHERE id = ?').pluck().get(cid)).toBeNull();

    await ds.undo(r.undoToken!);
    expect(dumpCore(db())).toEqual(before);
    expect(db().prepare('SELECT count(*) FROM character_vetoes WHERE character_id = ?').pluck().get(cid)).toBe(0);
    expect((await ds.listChanges('auto'))[0]).toMatchObject({ revertable: true, revertedAt: null });
  });

  it('角色之后改过标签就不能自动撤回', async () => {
    name('hoshino_(blue_archive)', '小鸟游星野', 4, { zh: '小鸟游星野', copyright: 'blue_archive' });
    const cid = Number(db().prepare("INSERT INTO characters (name, source, created_at) VALUES ('小鸟游星野', 'custom', ?)").run(NOW_ISO()).lastInsertRowid);
    db().prepare('INSERT INTO character_works (character_id, work_id) VALUES (?, ?)').run(cid, Number(env.id('work', 'w1')));
    (ds as unknown as { characters: { associateAutomatic(): void } }).characters.associateAutomatic();
    await ds.updateCharacter(String(cid), { danbooruTag: 'someone_else' });
    const [entry] = await ds.listChanges('auto');
    expect(entry).toMatchObject({ revertable: false });
    await expect(ds.revertChange(entry!.id)).rejects.toThrow('改过标签');
  });
});

describe('Pixiv 补充', () => {
  beforeEach(() => {
    name('yuuka_(blue_archive)', 'ユウカ');
    name('blue_archive', 'ブルーアーカイブ', 3);
    for (const [id, post] of [['i27', '555'], ['i28', '555'], ['i29', '556']] as const) {
      db().prepare("UPDATE images SET source_site = 'pixiv', source_post_id = ? WHERE id = ?").run(post, img(id));
    }
    queuePixivImages(ds.ctx, [img('i27'), img('i28'), img('i29')]);
  });

  it('一轮加的关联和原创标记记一条；撤回只动之后没改过的，去掉的角色记成不要；撤回可撤销', async () => {
    const client = { artwork: async (id: string) => (id === '555' ? art('555', ['ユウカ', 'ブルーアーカイブ']) : art('556', ['オリジナル'], { isOriginal: true })) };
    await syncPixivCharacters(ds.ctx, job(), ds.makeCatalog, client, 0);
    const yuuka = Number(env.id('character', 'c2'));
    expect(links(yuuka).filter((l) => [img('i27'), img('i28')].includes((l as { image_id: number }).image_id))).toEqual([
      { image_id: img('i27'), origin: 'tagger' },
      { image_id: img('i28'), origin: 'tagger' },
    ]);
    expect(db().prepare('SELECT original_at FROM images WHERE id = ?').pluck().get(img('i29'))).not.toBeNull();
    const [entry] = await ds.listChanges('auto');
    expect(entry).toMatchObject({ kind: 'pixiv-sync', count: 3, revertable: true });
    expect(entry!.summary).toBe('Pixiv 补充：给 2 张图加了角色（早濑优香），1 张标为原创');
    // 用户之后自己把 i28 的角色去掉了：撤回时不再管它
    await ds.updateImage(String(img('i28')), { characterIds: [] });
    expect((await ds.listChanges('auto'))[0]).toMatchObject({ count: 2 });
    const before = dumpCore(db());

    const r = await ds.revertChange(entry!.id);
    expect(r.message).toBe('已撤回 Pixiv 补充：去掉了1 个角色关联、1 张原创标记（2 张图）');
    expect(db().prepare('SELECT count(*) FROM image_characters WHERE image_id = ?').pluck().get(img('i27'))).toBe(0);
    expect(db().prepare('SELECT original_at FROM images WHERE id = ?').pluck().get(img('i29'))).toBeNull();
    expect(db().prepare('SELECT 1 FROM character_vetoes WHERE image_id = ? AND character_id = ?').get(img('i27'), yuuka)).toBeTruthy();
    expect(db().prepare('SELECT result FROM pixiv_character_checks WHERE image_id = ?').pluck().get(img('i27'))).toBe('dismissed');
    // 手动补跑也不会加回来
    queuePixivImages(ds.ctx);
    await syncPixivCharacters(ds.ctx, job(), ds.makeCatalog, client, 0);
    expect(db().prepare('SELECT count(*) FROM image_characters WHERE image_id = ?').pluck().get(img('i27'))).toBe(0);

    await ds.undo(r.undoToken!);
    expect(dumpCore(db())).toEqual(before);
  });

  it('什么都没加的一轮不记', async () => {
    await syncPixivCharacters(ds.ctx, job(), ds.makeCatalog, { artwork: async (id: string) => art(id, ['风景']) }, 0);
    expect(await ds.listChanges('auto')).toEqual([]);
  });
});

describe('切换 Pixiv 投稿号识别方式', () => {
  const TITLED = '未整理/144506494_キス魔な山賊.jpg';
  beforeEach(() => {
    name('yuuka_(blue_archive)', 'ユウカ');
    name('blue_archive', 'ブルーアーカイブ', 3);
    // i27：下载器命名，只有宽泛模式认；i28：标准命名，两种模式都认
    db().prepare('UPDATE images SET rel_path = ?, file_name = ? WHERE id = ?').run(TITLED, '144506494_キス魔な山賊.jpg', img('i27'));
    db().prepare("UPDATE images SET rel_path = '未整理/777777_p0.png', file_name = '777777_p0.png' WHERE id = ?").run(img('i28'));
    db().prepare("DELETE FROM settings WHERE key = 'sourceParserMode'").run();
  });

  it('先数影响，再切换：只去掉投稿号变了的 Pixiv 建议，切回来从缓存找回；可撤销', async () => {
    await ds.setSourceMode('broad');
    await ds.setSourceMode('strict');
    expect(db().prepare('SELECT source_post_id FROM images WHERE id = ?').pluck().all(img('i27'))).toEqual([null]);
    // 宽泛模式下补过一次 Pixiv：两张都有建议、投稿有缓存（两个角色名 → 只建议，不自动关联）
    await ds.setSourceMode('broad');
    const client = { artwork: async (id: string) => art(id, ['ユウカ', 'ヒナ', 'ブルーアーカイブ'], { pageCount: 2 }) };
    name('hina_(blue_archive)', 'ヒナ');
    queuePixivImages(ds.ctx, [img('i27'), img('i28')]);
    await syncPixivCharacters(ds.ctx, job(), ds.makeCatalog, client, 0);
    const pixivSugs = (id: string) => db().prepare("SELECT danbooru_tag FROM character_suggestions WHERE image_id = ? AND source = 'pixiv' ORDER BY danbooru_tag").pluck().all(img(id));
    expect(pixivSugs('i27')).toEqual(['hina_(blue_archive)', 'yuuka_(blue_archive)']);
    // i28 本来就有 hina 的模型建议，Pixiv 只补 yuuka
    expect(pixivSugs('i28')).toEqual(['yuuka_(blue_archive)']);

    expect(await ds.previewSourceMode('strict')).toEqual({ mode: 'strict', changed: 1, suggestionsDropped: 1, requeued: 0, cached: 0 });
    const toStrict = await ds.setSourceMode('strict');
    expect(toStrict.message).toBe('已改为严格：1 张图的来源变了；1 张的 Pixiv 建议先去掉了（投稿号变了，切回来能找回）');
    expect(pixivSugs('i27')).toEqual([]);
    // 投稿号没变的不动
    expect(pixivSugs('i28')).toEqual(['yuuka_(blue_archive)']);
    expect((await ds.getSettings()).tagger.pixivFilenameMode).toBe('strict');

    expect(await ds.previewSourceMode('broad')).toEqual({ mode: 'broad', changed: 1, suggestionsDropped: 0, requeued: 1, cached: 1 });
    const before = dumpCore(db());
    const toBroad = await ds.setSourceMode('broad');
    expect(toBroad.message).toBe('已改为宽泛：1 张图的来源变了；1 张从缓存找回了 Pixiv 角色');
    expect(pixivSugs('i27')).toEqual(['hina_(blue_archive)', 'yuuka_(blue_archive)']);

    await ds.undo(toBroad.undoToken!);
    expect((await ds.getSettings()).tagger.pixivFilenameMode).toBe('strict');
    expect(dumpCore(db())).toEqual(before);
    expect(await ds.setSourceMode('strict')).toMatchObject({ message: '已经是严格了', undoToken: null });
  });

  it('PUT /api/settings 改识别方式也照样处理', async () => {
    await ds.updateSettings({ tagger: { pixivFilenameMode: 'broad' } as never });
    expect(db().prepare('SELECT source_post_id FROM images WHERE id = ?').pluck().get(img('i27'))).toBe('144506494');
    expect((await ds.getSettings()).tagger.pixivFilenameMode).toBe('broad');
  });
});
