/**
 * 契约用例：同一套断言分别跑在 mock 和 sqlite 上。期望值见 test/fixtures/contract-db.ts 顶部注释。
 * 每组对应一个任务；sqlite 那边只有任务在 SQLITE_READY 里才跑。
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTmpDir } from '../helpers/tmp.ts';
import type { BulkImagesBody } from '@emaki/shared';
import { canon, contract, NOW, type ContractEnv, type ContractFactory } from './harness.ts';

type Name = 'mock' | 'sqlite';

function useEnv(make: ContractFactory): () => ContractEnv {
  let env: ContractEnv;
  beforeEach(async () => {
    env = await make();
  });
  afterEach(async () => {
    await env.close();
  });
  return () => env;
}

/** 一个肯定不存在的 id（sqlite 是整数，mock 是字符串） */
const missing = (env: ContractEnv, prefix: string) => (env.name === 'sqlite' ? '999999' : `${prefix}999`);

// ---------------------------------------------------------------- T02 设置

export function settingsContract(make: ContractFactory, name: Name) {
  contract('T02', '设置', name, () => {
    const env = useEnv(make);

    it('读取设置：文件夹、张数、默认值', async () => {
      const e = env();
      const s = await e.ds.getSettings();
      expect(s.libraryRoots.map((r) => [e.back('root', r.id), r.path, r.enabled, r.imageCount])).toEqual([
        ['root1', 'D:/Pics', true, 32],
        ['root2', 'E:/Old', false, 3],
      ]);
      expect(s.tagger.model).toBe('A1yCE/pixai-tagger-v1.0-onnx-fp16');
      expect(s.danbooru.hasApiKey).toBe(false);
      expect(s.ui).toEqual({ theme: 'system', blurSensitive: true, density: 'comfortable' });
    });

    it('调低自动采纳阈值：已达标的建议保存时立即归到角色', async () => {
      const e = env();
      expect((await e.ds.getStats()).unrecognizedCount).toBe(7);
      await e.ds.updateSettings({ tagger: { autoAcceptThreshold: 0.65 } });
      // i26 的 mika 建议 0.7 ≥ 0.65 → 归到圣园未花；i24 的 0.6 不够
      expect((await e.ds.getImage(e.id('image', 'i26')))!.characterIds.map((c) => e.back('character', c))).toEqual(['c1']);
      expect((await e.ds.getImage(e.id('image', 'i24')))!.characterIds).toEqual([]);
      expect((await e.ds.getStats()).unrecognizedCount).toBe(6);
      // 调高不会撤回
      await e.ds.updateSettings({ tagger: { autoAcceptThreshold: 0.9 } });
      expect((await e.ds.getStats()).unrecognizedCount).toBe(6);
    });

    it('修改设置：深合并，API key 只写不读', async () => {
      const e = env();
      const s = await e.ds.updateSettings({ ui: { theme: 'dark' }, danbooruApiKey: 'abc' });
      expect(s.ui).toEqual({ theme: 'dark', blurSensitive: true, density: 'comfortable' });
      expect(s.danbooru.hasApiKey).toBe(true);
      expect(JSON.stringify(s)).not.toContain('abc');
      expect((await e.ds.getSettings()).ui.theme).toBe('dark');
    });

    it('自定义画面：默认为空，整组替换', async () => {
      const e = env();
      expect((await e.ds.getSettings()).browse).toEqual({ customThemes: [] });
      const a = { id: 'a', name: '丝袜', tags: ['thighhighs', 'pantyhose'] };
      const b = { id: 'b', name: '眼镜', tags: ['glasses'] };
      await e.ds.updateSettings({ browse: { customThemes: [a, b] } });
      expect((await e.ds.getSettings()).browse.customThemes).toEqual([a, b]);
      // 改别的段不影响
      await e.ds.updateSettings({ ui: { density: 'compact' } });
      expect((await e.ds.getSettings()).browse.customThemes).toEqual([a, b]);
      await e.ds.updateSettings({ browse: { customThemes: [b] } });
      expect((await e.ds.getSettings()).browse.customThemes).toEqual([b]);
    });

    it('添加文件夹：规范化路径，重复添加报错', async () => {
      const e = env();
      // sqlite 会检查文件夹是否存在，所以用一个真实的临时目录
      const dir = makeTmpDir('root');
      try {
        const normalized = dir.replace(/\\/g, '/');
        const r = await e.ds.addLibraryRoot({ path: `${dir}\\` });
        expect(r.message).toBe(`已添加文件夹，开始扫描：${normalized}`);
        const roots = (await e.ds.getSettings()).libraryRoots;
        expect(roots.map((x) => x.path)).toContain(normalized);
        await expect(e.ds.addLibraryRoot({ path: normalized })).rejects.toThrow('这个文件夹已经在图库里了');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('停用文件夹可撤销', async () => {
      const e = env();
      const r = await e.ds.updateLibraryRoot(e.id('root', 'root1'), false);
      expect(r.undoToken).toBeTruthy();
      expect((await e.ds.getSettings()).libraryRoots[0]!.enabled).toBe(false);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getSettings()).libraryRoots[0]!.enabled).toBe(true);
    });

    it('移除文件夹可撤销', async () => {
      const e = env();
      const r = await e.ds.removeLibraryRoot(e.id('root', 'root2'));
      expect((await e.ds.getSettings()).libraryRoots.map((x) => x.path)).toEqual(['D:/Pics']);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getSettings()).libraryRoots.map((x) => x.path)).toEqual(['D:/Pics', 'E:/Old']);
    });
  });
}

// ---------------------------------------------------------------- T13 统计 / 作品 / 角色

export function statsContract(make: ContractFactory, name: Name) {
  contract('T13', '统计', name, () => {
    const env = useEnv(make);

    it('getStats 口径', async () => {
      const { customMatchableCount: _ignored, ...stats } = await env().ds.getStats();
      expect(stats).toEqual({
        imageCount: 32,
        characterCount: 7,
        workCount: 3,
        unrecognizedCount: 7,
        duplicateGroupCount: 1,
        excludedCount: 4,
        totalBytes: 3_200_000,
        addedLast7Days: [0, 0, 0, 8, 0, 0, 5],
        lastScanAt: new Date(NOW - 2 * 3_600_000).toISOString(),
        untaggedCount: 1,
        shelvedCount: 0,
        recentImport: null,
        lastAddedAt: new Date(NOW - 60_000).toISOString(),
        kindCounts: { illustration: 32, comic: 0, screenshot: 0, text: 0, photo: 0, meme: 0, animated: 0 },
        pendingTagCount: 1,
        collectionCounts: { doujin: 0, artbook: 0 },
        pendingCollectionCount: 0,
      });
    });
  });
}

export function worksContract(make: ContractFactory, name: Name) {
  contract('T13', '作品', name, () => {
    const env = useEnv(make);

    it('covers：最多 3 张、互不重复，第一张就是 coverImageId（T26 / T28）', async () => {
      const works = await env().ds.listWorks({});
      for (const w of works) {
        expect(w.covers.length).toBeLessThanOrEqual(3);
        expect(new Set(w.covers.map((c) => c.imageId)).size).toBe(w.covers.length);
        expect(w.covers[0]?.imageId ?? null).toBe(w.coverImageId);
      }
    });

    it('默认按张数排序，计数正确', async () => {
      const e = env();
      const works = await e.ds.listWorks({});
      expect(works.map((w) => [e.back('work', w.id), w.name, w.imageCount, w.recentImageCount, w.characterCount])).toEqual([
        ['w1', '蔚蓝档案', 16, 11, 4],
        ['w2', '原神', 12, 6, 3],
        ['w3', '我的原创', 1, 0, 1],
      ]);
      expect(works[0]!.aliases).toEqual(['ブルーアーカイブ', 'BA']);
      expect(works[0]!.danbooruTag).toBe('blue_archive');
      expect(works[0]!.color).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('按最近 / 名字排序', async () => {
      const e = env();
      expect((await e.ds.listWorks({ sort: 'recent' })).map((w) => e.back('work', w.id))).toEqual(['w1', 'w2', 'w3']);
      // 中文按拼音：蔚(wei) < 我(wo) < 原(yuan)
      expect((await e.ds.listWorks({ sort: 'name' })).map((w) => w.name)).toEqual(['蔚蓝档案', '我的原创', '原神']);
    });

    it('getWork', async () => {
      const e = env();
      const w = await e.ds.getWork(e.id('work', 'w2'));
      expect(w?.name).toBe('原神');
      expect(w?.imageCount).toBe(12);
      expect(await e.ds.getWork(missing(e, 'w'))).toBeNull();
    });
  });
}

export function charactersContract(make: ContractFactory, name: Name) {
  contract('T13', '角色', name, () => {
    const env = useEnv(make);
    const ids = (e: ContractEnv, list: { id: string }[]) => list.map((c) => e.back('character', c.id));

    it('默认排序：置顶在前，再按张数', async () => {
      const e = env();
      const page = await e.ds.listCharacters({});
      expect(ids(e, page.items)).toEqual(['c3', 'c1', 'c4', 'c2', 'c5', 'c6', 'c7']);
      expect(page.items.map((c) => c.imageCount)).toEqual([3, 8, 6, 4, 3, 2, 1]);
      expect(page.total).toBe(7);
      expect(page.nextCursor).toBeNull();
    });

    it('搜索：别名、Danbooru 标签、作品名', async () => {
      const e = env();
      expect(ids(e, (await e.ds.listCharacters({ q: 'ミカ' })).items)).toEqual(['c1']);
      expect(ids(e, (await e.ds.listCharacters({ q: 'mika' })).items)).toEqual(['c1']);
      expect(ids(e, (await e.ds.listCharacters({ q: 'ブルーアーカイブ' })).items)).toEqual(['c3', 'c1', 'c2', 'c6']);
    });

    it('按作品 / 最近 / 来源筛选', async () => {
      const e = env();
      expect(ids(e, (await e.ds.listCharacters({ workId: e.id('work', 'w2') })).items)).toEqual(['c4', 'c5', 'c6']);
      expect(ids(e, (await e.ds.listCharacters({ workId: 'recent' })).items)).toEqual(['c3', 'c1', 'c4', 'c2', 'c5', 'c6']);
      expect(ids(e, (await e.ds.listCharacters({ source: 'custom' })).items)).toEqual(['c7']);
    });

    it('按名字排序（置顶仍在前，其余按拼音）', async () => {
      const e = env();
      expect(ids(e, (await e.ds.listCharacters({ sort: 'name' })).items)).toEqual(['c3', 'c4', 'c6', 'c5', 'c1', 'c7', 'c2']);
    });

    it('分页', async () => {
      const e = env();
      const p1 = await e.ds.listCharacters({ limit: 3 });
      expect(ids(e, p1.items)).toEqual(['c3', 'c1', 'c4']);
      expect(p1.total).toBe(7);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await e.ds.listCharacters({ limit: 3, cursor: p1.nextCursor! });
      expect(ids(e, p2.items)).toEqual(['c2', 'c5', 'c6']);
    });

    it('topCharacters 只按张数', async () => {
      const e = env();
      expect(ids(e, await e.ds.topCharacters({ limit: 3 }))).toEqual(['c1', 'c4', 'c2']);
      expect(ids(e, await e.ds.topCharacters({ workId: e.id('work', 'w2') }))).toEqual(['c4', 'c5', 'c6']);
    });

    it('getCharacter：作品与同框角色', async () => {
      const e = env();
      const res = await e.ds.getCharacter(e.id('character', 'c1'));
      expect(res?.character.name).toBe('圣园未花');
      expect(res?.character.imageCount).toBe(8);
      expect(res?.character.aliases).toEqual(['ミカ', '未花']);
      expect(res?.character.lastAddedAt).toBe(new Date(NOW - 60_000).toISOString());
      expect(res?.works.map((w) => e.back('work', w.id))).toEqual(['w1']);
      expect(res?.related.map((r) => [e.back('character', r.character.id), r.sharedCount])).toEqual([
        ['c2', 1],
        ['c3', 1],
      ]);
      const c6 = await e.ds.getCharacter(e.id('character', 'c6'));
      expect(c6?.character.workIds.map((w) => e.back('work', w))).toEqual(['w1', 'w2']);
      expect(await e.ds.getCharacter(missing(e, 'c'))).toBeNull();
    });

    it('换封面候选（CB-7）：只列计入的图，安全档在前、按质量分排；自动封面排第一；恢复自动后回到自动封面', async () => {
      const e = env();
      const imgs = (list: { id: string }[]) => list.map((x) => e.back('image', x.id));
      const c1 = e.id('character', 'c1');
      // i31 排除、i35 回收站、i39/i40 停用文件夹都不在；i1 收藏最高；i5 方图 > i7/i8 合影（同分按 id 倒序）> i3 横图；Q、E 最后
      const all = await e.ds.listCoverCandidates(c1, 12);
      expect(imgs(all.items)).toEqual(['i1', 'i2', 'i5', 'i8', 'i7', 'i3', 'i4', 'i6']);
      expect(all.items.every((x) => typeof x.coverScore === 'number')).toBe(true);
      expect(all.items[0]!.coverScore).toBeGreaterThan(all.items[1]!.coverScore);
      expect(imgs((await e.ds.listCoverCandidates(c1, 3)).items)).toEqual(['i1', 'i2', 'i5']);

      // 没有手动封面的角色：第一张就是当前封面
      for (const cid of ['c2', 'c3', 'c5', 'c6', 'c7']) {
        const ch = (await e.ds.getCharacter(e.id('character', cid)))!.character;
        expect(ch.coverManual).toBe(false);
        expect((await e.ds.listCoverCandidates(ch.id, 12)).items[0]?.id ?? null).toBe(ch.coverImageId);
      }

      // 手动选第 3 张 → coverManual；恢复自动 → 回到候选第一张；可撤销
      const pick = all.items[2]!.id;
      await e.ds.updateCharacter(c1, { coverImageId: pick });
      expect((await e.ds.getCharacter(c1))!.character).toMatchObject({ coverImageId: pick, coverManual: true });
      const r = await e.ds.updateCharacter(c1, { coverImageId: null });
      const auto = (await e.ds.getCharacter(c1))!.character;
      expect(auto.coverManual).toBe(false);
      expect(auto.coverImageId).toBe((await e.ds.listCoverCandidates(c1, 1)).items[0]!.id);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getCharacter(c1))!.character).toMatchObject({ coverImageId: pick, coverManual: true });

      await expect(e.ds.listCoverCandidates(missing(e, 'c'), 12)).rejects.toMatchObject({ statusCode: 404 });
    });
  });
}

export function characterMutationsContract(make: ContractFactory, name: Name) {
  contract('T14', '角色编辑', name, () => {
    const env = useEnv(make);

    it('新建自建角色；空名 400、作品不存在 404、标签重复 409；可撤销', async () => {
      const e = env();
      const r = await e.ds.createCharacter({ name: ' 雪之下 ', workIds: [e.id('work', 'w3')], aliases: ['yukino', '雪乃'] });
      expect(r.message).toBe('已新建角色「雪之下」');
      expect(r.character).toMatchObject({ name: '雪之下', source: 'custom', danbooruTag: null, aliases: ['yukino', '雪乃'] });
      expect(r.character.workIds.map((w) => e.back('work', w))).toEqual(['w3']);
      expect((await e.ds.listCharacters({ source: 'custom' })).total).toBe(2);
      await expect(e.ds.createCharacter({ name: '  ', workIds: [] })).rejects.toThrow('角色名不能为空');
      await expect(e.ds.createCharacter({ name: 'x', workIds: [missingWork(e)] })).rejects.toMatchObject({ statusCode: 404 });
      await expect(e.ds.createCharacter({ name: 'x', workIds: [], danbooruTag: 'mika_(blue_archive)' })).rejects.toMatchObject({ statusCode: 409 });
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.listCharacters({ source: 'custom' })).total).toBe(1);
    });

    it('改名 / 别名 / 置顶，可撤销', async () => {
      const e = env();
      const id = e.id('character', 'c5');
      const r = await e.ds.updateCharacter(id, { name: '小吉祥草王', aliases: ['草神'], pinned: true });
      expect(r.message).toBe('已更新「小吉祥草王」');
      const page = await e.ds.listCharacters({});
      // 置顶的排最前（c3 原本就置顶；同为置顶时按张数：c3 3 张、c5 3 张，保持原顺序）
      expect(page.items.slice(0, 2).map((c) => e.back('character', c.id)).sort()).toEqual(['c3', 'c5']);
      const c = (await e.ds.getCharacter(id))!.character;
      expect(c).toMatchObject({ name: '小吉祥草王', aliases: ['草神'], pinned: true });
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getCharacter(id))!.character).toMatchObject({ name: '纳西妲', pinned: false });
    });

    it('合并：被合并的消失，目标张数 = 并集；提示里的张数；可撤销', async () => {
      const e = env();
      const r = await e.ds.mergeCharacter(e.id('character', 'c1'), e.id('character', 'c3'));
      expect(r.message).toBe('已把「圣园未花」合并进「空崎日奈」（12 张）');
      expect(await e.ds.getCharacter(e.id('character', 'c1'))).toBeNull();
      const to = (await e.ds.getCharacter(e.id('character', 'c3')))!.character;
      expect(to.imageCount).toBe(10); // c1 8 张 + c3 3 张，i8 两人同框
      expect(to.aliases).toEqual(expect.arrayContaining(['圣园未花', 'ミカ', '未花']));
      await expect(e.ds.mergeCharacter(e.id('character', 'c2'), e.id('character', 'c2'))).rejects.toThrow('不能合并到自己');
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getCharacter(e.id('character', 'c1')))!.character.imageCount).toBe(8);
      expect((await e.ds.getCharacter(e.id('character', 'c3')))!.character.imageCount).toBe(3);
    });

    it('markCharacterSeen 清掉 +N', async () => {
      const e = env();
      const id = e.id('character', 'c1');
      expect((await e.ds.getCharacter(id))!.character.newCount).toBeGreaterThan(0);
      await e.ds.markCharacterSeen(id);
      expect((await e.ds.getCharacter(id))!.character.newCount).toBe(0);
    });
  });
}

const missingWork = (e: ContractEnv) => (e.name === 'sqlite' ? '999999' : 'w999');
export function unrecognizedContract(make: ContractFactory, name: Name) {
  contract('T15', '未识别', name, () => {
    const env = useEnv(make);
    const ids = (e: ContractEnv, items: { image: { id: string } }[]) => items.map((x) => e.back('image', x.image.id));

    it('suggestedCount：整个队列里有建议的张数，不受分页影响；采纳后减少', async () => {
      const e = env();
      expect((await e.ds.listUnrecognized({ limit: 1 })).suggestedCount).toBe(5);
      await e.ds.acceptSuggestion(e.id('image', 'i28'), 'hina_(blue_archive)');
      expect((await e.ds.listUnrecognized({ limit: 1 })).suggestedCount).toBe(4);
    });

    it('分段：有建议 / 没认出 / 待识别；三个计数与分段过滤一致', async () => {
      const e = env();
      const all = await e.ds.listUnrecognized({ limit: 200 });
      expect([all.suggestedCount, all.unsureCount, all.untaggedCount]).toEqual([5, 1, 1]);
      expect(all.total).toBe(7);
      const s = await e.ds.listUnrecognized({ bucket: 'suggested', limit: 200 });
      expect(s.total).toBe(5);
      expect(s.items.every((x) => x.suggestions.length > 0)).toBe(true);
      const u = await e.ds.listUnrecognized({ bucket: 'unsure', limit: 200 });
      expect(u.items.map((x) => [x.suggestions.length, x.tagged])).toEqual([[0, true]]);
      const t = await e.ds.listUnrecognized({ bucket: 'untagged', limit: 200 });
      expect(ids(e, t.items)).toEqual(['i30']);
      expect(t.items[0]!.tagged).toBe(false);
    });

    it('顺序：有建议按置信度倒序、插画在漫画前；翻页不重不漏', async () => {
      const e = env();
      const all: string[] = [];
      let cursor: string | undefined;
      let total = 0;
      do {
        const page = await e.ds.listUnrecognized({ limit: 5, cursor });
        all.push(...ids(e, page.items));
        total = page.total;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(all).toEqual(['i26', 'i24', 'i27', 'i28', 'i29', 'i25', 'i30']);
      expect(total).toBe((await e.ds.getStats()).unrecognizedCount);
      const first = await e.ds.listUnrecognized({ limit: 1 });
      expect(first.items[0]!.suggestions.map((s) => s.danbooruTag)).toEqual(['mika_(blue_archive)', 'yuuka_(blue_archive)']);
      expect(first.items[0]!.tagged).toBe(true);
    });

    it('汇总与列表、getStats 一致（T34a）', async () => {
      const e = env();
      const sum = await e.ds.unrecognizedSummary();
      expect(sum.art).toMatchObject({ total: 7, suggested: 5, unsure: 1, untagged: 1, shelved: 0 });
      expect(Object.entries(sum.art.themes).filter(([, n]) => n > 0)).toEqual([['legs', 1]]);
      expect(sum.annex.total).toBe(0);
      expect(Object.values(sum.annex.kinds).every((n) => n === 0)).toBe(true);
      const first = await e.ds.listUnrecognized({ limit: 1 });
      expect([first.suggestedCount, first.unsureCount, first.untaggedCount]).toEqual([5, 1, 1]);
      expect((await e.ds.getStats()).unrecognizedCount).toBe(7);
    });

    it('主题：分级改成较敏感就归「敏感」，可撤销（T34a）', async () => {
      const e = env();
      expect(ids(e, (await e.ds.listUnrecognized({ bucket: 'unsure', theme: 'legs' })).items)).toEqual(['i25']);
      const r = await e.ds.bulkImages({ ids: [e.id('image', 'i25')], action: { type: 'rating', value: 'questionable' } });
      let sum = await e.ds.unrecognizedSummary();
      expect([sum.art.themes.nsfw, sum.art.themes.legs]).toEqual([1, 0]);
      expect(ids(e, (await e.ds.listUnrecognized({ bucket: 'unsure', theme: 'nsfw' })).items)).toEqual(['i25']);
      await e.ds.undo(r.undoToken!);
      sum = await e.ds.unrecognizedSummary();
      expect(sum.art.themes.legs).toBe(1);
    });

    it('放下：离开队列，进「放下的」；可撤销、可放回（T34a）', async () => {
      const e = env();
      const i25 = e.id('image', 'i25');
      const r = await e.ds.bulkImages({ ids: [i25], action: { type: 'shelve', value: true } });
      expect(r.message).toBe('已放下 1 张图，不再出现在未识别');
      let stats = await e.ds.getStats();
      expect([stats.unrecognizedCount, stats.shelvedCount]).toEqual([6, 1]);
      const sum = await e.ds.unrecognizedSummary();
      expect(sum.art).toMatchObject({ shelved: 1, unsure: 0, total: 6 });
      expect(ids(e, (await e.ds.listUnrecognized({ bucket: 'shelved' })).items)).toEqual(['i25']);
      expect((await e.ds.listImages({ status: 'unrecognized' })).total).toBe(7);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getStats()).unrecognizedCount).toBe(7);
      await e.ds.bulkImages({ ids: [i25], action: { type: 'shelve', value: true } });
      await e.ds.bulkImages({ ids: [i25], action: { type: 'shelve', value: false } });
      stats = await e.ds.getStats();
      expect([stats.unrecognizedCount, stats.shelvedCount]).toEqual([7, 0]);
    });

    it('归为原创：离开未识别、挂到「原创」作品；可撤销、可移出', async () => {
      const e = env();
      const i25 = e.id('image', 'i25');
      const r = await e.ds.bulkImages({ ids: [i25], action: { type: 'original', value: true } });
      expect(r.message).toBe('已把 1 张图归为原创，不再出现在未识别');
      expect((await e.ds.getStats()).unrecognizedCount).toBe(6);
      expect((await e.ds.unrecognizedSummary()).art.total).toBe(6);
      expect((await e.ds.listImages({ status: 'unrecognized' })).total).toBe(6);
      expect((await e.ds.getImage(i25))?.status).toBe('recognized');
      const original = (await e.ds.listWorks({})).find((w) => w.name === '原创');
      expect(original).toBeDefined();
      expect((await e.ds.listImages({ workId: original!.id })).items.map((x) => e.back('image', x.id))).toContain('i25');
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getStats()).unrecognizedCount).toBe(7);
      await e.ds.bulkImages({ ids: [i25], action: { type: 'original', value: true } });
      await e.ds.bulkImages({ ids: [i25], action: { type: 'original', value: false } });
      expect((await e.ds.getStats()).unrecognizedCount).toBe(7);
      expect((await e.ds.listImages({ workId: original!.id })).items.map((x) => e.back('image', x.id))).not.toContain('i25');
    });

    it('重新识别：范围是识别过、没认出的插画（不含没识别过的、放下的、原创），并启动识别任务', async () => {
      const e = env();
      expect((await e.ds.unrecognizedSummary()).art.retaggable).toBe(6);
      await e.ds.bulkImages({ ids: [e.id('image', 'i25')], action: { type: 'shelve', value: true } });
      await e.ds.bulkImages({ ids: [e.id('image', 'i24')], action: { type: 'original', value: true } });
      expect((await e.ds.getImage(e.id('image', 'i24')))?.original).toBe(true);
      expect((await e.ds.getImage(e.id('image', 'i26')))?.original).toBe(false);
      expect((await e.ds.unrecognizedSummary()).art.retaggable).toBe(4);
      const r = await e.ds.retagUnrecognized();
      expect(r.marked).toBe(4);
      expect(r.job?.kind).toBe('tag');
      await e.ds.cancelJob(r.job!.id); // 测试里不真的跑模型
    });

    it('改类型后换大类；有建议里插画在漫画前（T34a）', async () => {
      const e = env();
      await e.ds.bulkImages({ ids: [e.id('image', 'i25')], action: { type: 'kind', value: 'photo' } });
      const sum = await e.ds.unrecognizedSummary();
      expect([sum.annex.kinds.photo, sum.annex.total, sum.art.total]).toEqual([1, 1, 6]);
      const annex = await e.ds.listUnrecognized({ area: 'annex', kind: 'photo' });
      expect(ids(e, annex.items)).toEqual(['i25']);
      expect(annex.annexCount).toBe(1);
      await e.ds.bulkImages({ ids: [e.id('image', 'i26')], action: { type: 'kind', value: 'comic' } });
      expect(ids(e, (await e.ds.listUnrecognized({ bucket: 'suggested' })).items)).toEqual(['i24', 'i27', 'i28', 'i29', 'i26']);
    });

    it('theme、bucket 和大类不匹配时忽略，不报错（T34a）', async () => {
      const e = env();
      await e.ds.bulkImages({ ids: [e.id('image', 'i25')], action: { type: 'kind', value: 'photo' } });
      const r = await e.ds.listUnrecognized({ area: 'annex', theme: 'legs', bucket: 'unsure' });
      expect(ids(e, r.items)).toEqual(['i25']);
      // theme 只在 unsure 里生效：有建议的列表不受影响
      expect((await e.ds.listUnrecognized({ bucket: 'suggested', theme: 'legs' })).total).toBe(5);
    });

    it('采纳已有角色；可撤销', async () => {
      const e = env();
      const r = await e.ds.acceptSuggestion(e.id('image', 'i26'), 'mika_(blue_archive)');
      expect(r.message).toBe('已归到「圣园未花」');
      expect((await e.ds.getStats()).unrecognizedCount).toBe(6);
      expect((await e.ds.getImage(e.id('image', 'i26')))!.characterIds.map((c) => e.back('character', c))).toEqual(['c1']);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getStats()).unrecognizedCount).toBe(7);
    });

    it('采纳库里没有的标签会新建角色', async () => {
      const e = env();
      const r = await e.ds.acceptSuggestion(e.id('image', 'i27'), 'test_girl_(emaki_test)');
      expect(r.message).toBe('已新建角色「Test Girl」并归入');
      const found = (await e.ds.listCharacters({ q: 'Test Girl' })).items;
      expect(found.map((c) => [c.name, c.imageCount])).toEqual([['Test Girl', 1]]);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.listCharacters({ q: 'Test Girl' })).total).toBe(0);
    });
  });
}
// ---------------------------------------------------------------- T17 排除

export function exclusionsContract(make: ContractFactory, name: Name) {
  contract('T17', '排除', name, () => {
    const env = useEnv(make);

    it('列出规则与张数（新的在前）', async () => {
      const e = env();
      const list = await e.ds.listExclusions();
      expect(list.map((x) => [e.back('exclusion', x.id), x.kind, x.target, x.label, x.imageCount])).toEqual([
        ['x2', 'tag', 'comic', '标签 · comic', 2],
        ['x1', 'folder', 'D:/Pics/memes', '文件夹 · D:/Pics/memes', 2],
      ]);
      expect(list[1]!.previewImageIds.map((id) => e.back('image', id)).sort()).toEqual(['i31', 'i32']);
    });

    it('按角色新建规则：张数减少，可撤销', async () => {
      const e = env();
      const res = await e.ds.createExclusion({ kind: 'character', target: e.id('character', 'c5') });
      expect(res.message).toBe('已排除：角色 · 纳西妲（3 张）');
      let stats = await e.ds.getStats();
      expect([stats.imageCount, stats.excludedCount]).toEqual([29, 7]);
      await e.ds.undo(res.undoToken!);
      stats = await e.ds.getStats();
      expect([stats.imageCount, stats.excludedCount]).toEqual([32, 4]);
      expect(await e.ds.listExclusions()).toHaveLength(2);
    });

    it('按文件夹 / 标签新建规则', async () => {
      const e = env();
      await e.ds.createExclusion({ kind: 'folder', target: 'D:/Pics/角色' });
      expect((await e.ds.getStats()).imageCount).toBe(7); // 只剩未识别的 i24–i30
      await e.ds.createExclusion({ kind: 'tag', target: '1girl' });
      expect((await e.ds.getStats()).imageCount).toBe(0);
    });

    it('按单张新建规则', async () => {
      const e = env();
      const res = await e.ds.createExclusion({ kind: 'image', target: e.id('image', 'i1') });
      expect(res.message).toBe('已排除：单张 · i1.png（1 张）');
      expect((await e.ds.getStats()).imageCount).toBe(31);
    });

    it('删除规则恢复图片（可撤销）', async () => {
      const e = env();
      const res = await e.ds.deleteExclusion(e.id('exclusion', 'x1'));
      expect(res.message).toBe('已恢复：文件夹 · D:/Pics/memes（2 张）');
      expect((await e.ds.getStats()).imageCount).toBe(34);
      await e.ds.undo(res.undoToken!);
      expect((await e.ds.getStats()).imageCount).toBe(32);
      expect((await e.ds.listExclusions()).map((x) => e.back('exclusion', x.id))).toEqual(['x2', 'x1']);
    });

    it('错误：空目标 / 不存在的规则', async () => {
      const e = env();
      await expect(e.ds.createExclusion({ kind: 'tag', target: '  ' })).rejects.toMatchObject({ code: 'bad_request' });
      await expect(e.ds.deleteExclusion(missing(e, 'x'))).rejects.toMatchObject({ code: 'not_found' });
    });
  });
}
export function searchContract(make: ContractFactory, name: Name) {
  contract('T20', '搜索', name, () => {
    const env = useEnv(make);
    const run = async (q: string, limit?: number) => {
      const e = env();
      return (await e.ds.search({ q, limit })).map((h) =>
        h.type === 'character'
          ? `c:${e.back('character', h.character.id)}/${h.workName}`
          : h.type === 'work'
            ? `w:${e.back('work', h.work.id)}`
            : `t:${h.tag}=${h.imageCount}`,
      );
    };

    it('别名与假名归一化：中文名、片假名、平假名、罗马字、Danbooru 标签', async () => {
      for (const q of ['未花', 'ミカ', 'みか', 'mika', 'Mika_(Blue_Archive)']) expect(await run(q)).toEqual(['c:c1/蔚蓝档案']);
    });

    it('角色 / 作品 / 标签分组：作品别名也能搜到它的角色，按张数排序', async () => {
      expect(await run('BA')).toEqual(['c:c1/蔚蓝档案', 'c:c2/蔚蓝档案', 'c:c3/蔚蓝档案', 'c:c6/蔚蓝档案', 'w:w1']);
      expect(await run('げんしん')).toEqual(['c:c4/原神', 'c:c5/原神', 'c:c6/蔚蓝档案', 'w:w2']);
      // 名额很少时也给作品留位置
      expect(await run('BA', 2)).toEqual(['c:c1/蔚蓝档案', 'w:w1']);
    });

    it('标签只算计入张数的图：被排除的 comic 不出现', async () => {
      expect(await run('girl')).toEqual(['t:1girl=32']);
      expect(await run('comic')).toEqual([]);
    });

    it('空查询、全空白、只有符号 → 空', async () => {
      for (const q of ['', '  ', '_']) expect(await run(q)).toEqual([]);
    });

    it('标签联想：只要一般标签，按张数；空查询 = 最常见的；被排除的不算', async () => {
      const e = env();
      const tags = async (q?: string, limit?: number) => (await e.ds.tagSuggestions({ q, limit })).map((t) => `${t.tag}=${t.count}`);
      expect(await tags('thigh')).toEqual(['thighhighs=1']);
      expect(await tags('')).toEqual(['1girl=32', 'thighhighs=1']);
      expect(await tags(undefined, 1)).toEqual(['1girl=32']);
      expect(await tags('comic')).toEqual([]);
      // 角色标签不出现
      expect(await tags('blue_archive')).toEqual([]);
      const [s] = await e.ds.tagSuggestions({ q: 'thighhighs' });
      expect(s?.name).toBeTruthy();
    });
  });
}
export function imagesContract(make: ContractFactory, name: Name) {
  contract('T05', '图片', name, () => {
    const env = useEnv(make);
    const ids = (e: ContractEnv, list: { id: string }[]) => list.map((i) => e.back('image', i.id));

    it('默认：入库时间倒序，不含排除 / 回收站 / 停用文件夹', async () => {
      const e = env();
      const page = await e.ds.listImages({ limit: 5 });
      expect(page.total).toBe(32);
      expect(ids(e, page.items)).toEqual(['i1', 'i2', 'i9', 'i14', 'i26']);
      expect(page.nextCursor).not.toBeNull();
      const next = await e.ds.listImages({ limit: 5, cursor: page.nextCursor! });
      expect(ids(e, next.items)).toEqual(['i3', 'i7', 'i12', 'i15', 'i21']);
    });

    it('按状态 / 角色 / 作品 / 分级 / 收藏 / 方向筛选', async () => {
      const e = env();
      const total = async (q: Parameters<typeof e.ds.listImages>[0]) => (await e.ds.listImages(q)).total;
      expect(await total({ status: 'unrecognized' })).toBe(7);
      expect(await total({ status: 'excluded' })).toBe(4);
      expect(await total({ characterId: e.id('character', 'c1') })).toBe(8);
      expect(await total({ workId: e.id('work', 'w2') })).toBe(12);
      expect(ids(e, (await e.ds.listImages({ rating: ['explicit'] })).items)).toEqual(['i6']);
      expect(ids(e, (await e.ds.listImages({ favorite: true })).items)).toEqual(['i1']);
      expect(ids(e, (await e.ds.listImages({ orientation: 'landscape' })).items).sort()).toEqual(['i15', 'i3', 'i37']);
      expect(ids(e, (await e.ds.listImages({ orientation: 'square' })).items)).toEqual(['i5']);
      expect(await total({ q: 'comic', status: 'excluded' })).toBe(2);
    });

    it('按画面筛选（多归属，只看识别过的图）', async () => {
      const e = env();
      expect(ids(e, (await e.ds.listImages({ theme: 'legs' })).items)).toEqual(['i25']);
      expect((await e.ds.listImages({ theme: 'kemono' })).total).toBe(0);
      expect((await e.ds.listImages({ theme: 'legs', status: 'recognized' })).total).toBe(0);
      expect((await e.ds.listImages({ theme: 'legs', workId: e.id('work', 'w2') })).total).toBe(1);
    });

    it('按标签筛选（自定义画面）：任一标签命中；未知标签 → 空', async () => {
      const e = env();
      expect(ids(e, (await e.ds.listImages({ tags: ['thighhighs'] })).items)).toEqual(['i25']);
      expect(ids(e, (await e.ds.listImages({ tags: ['no_such_tag', 'thighhighs'] })).items)).toEqual(['i25']);
      expect((await e.ds.listImages({ tags: ['no_such_tag'] })).total).toBe(0);
      // comic 的两张都被排除了
      expect((await e.ds.listImages({ tags: ['comic', 'thighhighs'] })).total).toBe(1);
      expect(ids(e, (await e.ds.listImages({ tags: ['comic'], status: 'excluded' })).items).sort()).toEqual(['i33', 'i34']);
      expect((await e.ds.listImages({ tags: ['thighhighs'], workId: e.id('work', 'w1') })).total).toBe(0);
    });

    it('getImage：标签与建议；不可见返回 null', async () => {
      const e = env();
      const img = await e.ds.getImage(e.id('image', 'i24'));
      expect(img?.status).toBe('unrecognized');
      expect(img?.workIds.map((w) => e.back('work', w))).toEqual(['w1']);
      expect(img?.tags.map((t) => t.tag)).toContain('1girl');
      expect(img?.characterSuggestions.map((s) => [s.danbooruTag, s.name, s.workName, s.characterId && e.back('character', s.characterId)])).toEqual([
        ['mika_(blue_archive)', '圣园未花', '蔚蓝档案', 'c1'],
      ]);
      const unknown = await e.ds.getImage(e.id('image', 'i27'));
      expect(unknown?.characterSuggestions[0]).toMatchObject({ danbooruTag: 'test_girl_(emaki_test)', name: 'Test Girl', characterId: null });
      expect(await e.ds.getImage(e.id('image', 'i35'))).toBeNull(); // 回收站
      expect(await e.ds.getImage(e.id('image', 'i39'))).toBeNull(); // 停用的文件夹
    });

    it('updateImage 可撤销', async () => {
      const e = env();
      const id = e.id('image', 'i2');
      const r = await e.ds.updateImage(id, { favorite: true, characterIds: [e.id('character', 'c2')] });
      expect(r.message).toBe('已收藏');
      let img = await e.ds.getImage(id);
      expect(img?.favorite).toBe(true);
      expect(img?.characterIds.map((c) => e.back('character', c))).toEqual(['c2']);
      await e.ds.undo(r.undoToken!);
      img = await e.ds.getImage(id);
      expect(img?.favorite).toBe(false);
      expect(img?.characterIds.map((c) => e.back('character', c))).toEqual(['c1']);
    });
  });
}
export function duplicatesContract(make: ContractFactory, name: Name) {
  contract('T16', '重复', name, () => {
    const env = useEnv(make);
    const brief = (e: ContractEnv, gs: Awaited<ReturnType<ContractEnv['ds']['listDuplicates']>>) =>
      gs.map((g) => ({
        id: e.back('duplicate', g.id),
        kind: g.kind,
        similarity: g.similarity,
        images: g.images.map((i) => e.back('image', i.id)),
        keep: e.back('image', g.suggestedKeepId),
        resolved: g.resolved,
      }));

    it('只列未解决且可见成员 ≥ 2 的组；已处理的单独列', async () => {
      const e = env();
      expect(brief(e, await e.ds.listDuplicates({}))).toEqual([
        { id: 'd1', kind: 'similar', similarity: 0.95, images: ['i15', 'i37'], keep: 'i15', resolved: false },
      ]);
      expect(brief(e, await e.ds.listDuplicates({ resolved: true }))).toEqual([
        { id: 'd2', kind: 'exact', similarity: 1, images: ['i20', 'i38'], keep: 'i20', resolved: true },
      ]);
    });

    it('全部保留：标为已处理，可撤销', async () => {
      const e = env();
      const d1 = e.id('duplicate', 'd1');
      const keep = [e.id('image', 'i15'), e.id('image', 'i37')];
      const r = await e.ds.resolveDuplicate(d1, keep);
      expect(r.message).toBe('已保留 2 张，0 张移到回收站');
      expect(await e.ds.listDuplicates({})).toEqual([]);
      expect((await e.ds.getStats()).duplicateGroupCount).toBe(0);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.listDuplicates({})).map((g) => e.back('duplicate', g.id))).toEqual(['d1']);
    });

    it('resolve 参数校验：空保留 400、组外图片 400、不存在的组 404', async () => {
      const e = env();
      const d1 = e.id('duplicate', 'd1');
      await expect(e.ds.resolveDuplicate(d1, [])).rejects.toMatchObject({ statusCode: 400, message: '至少保留一张' });
      await expect(e.ds.resolveDuplicate(d1, [e.id('image', 'i1')])).rejects.toMatchObject({ statusCode: 400 });
      await expect(e.ds.resolveDuplicate(missing(e, 'd'), [e.id('image', 'i15')])).rejects.toMatchObject({ statusCode: 404 });
    });

    it('ignore：进入已处理，可撤销', async () => {
      const e = env();
      const r = await e.ds.ignoreDuplicate(e.id('duplicate', 'd1'));
      expect(r.message).toBe('已标记为「不是重复」');
      expect(await e.ds.listDuplicates({})).toEqual([]);
      expect((await e.ds.listDuplicates({ resolved: true })).map((g) => e.back('duplicate', g.id)).sort()).toEqual(['d1', 'd2']);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.listDuplicates({})).map((g) => e.back('duplicate', g.id))).toEqual(['d1']);
      await expect(e.ds.ignoreDuplicate(missing(e, 'd'))).rejects.toMatchObject({ statusCode: 404 });
    });
  });
}
export function bulkContract(make: ContractFactory, name: Name) {
  contract('T18', '批量操作', name, () => {
    const env = useEnv(make);
    const snapshot = async (e: ContractEnv, ids: string[]) =>
      Promise.all(ids.map(async (id) => canon(e, await e.ds.getImage(id))));

    const cases: [string, (e: ContractEnv) => BulkImagesBody['action'], string, (e: ContractEnv, ids: string[]) => Promise<void>][] = [
      ['assign', (e) => ({ type: 'assign', characterId: e.id('character', 'c7') }), '已将 2 张图归到「雪见」', async (e, ids) => {
        for (const id of ids) expect((await e.ds.getImage(id))!.characterIds.map((c) => e.back('character', c))).toContain('c7');
      }],
      ['unassign', (e) => ({ type: 'unassign', characterId: e.id('character', 'c1') }), '已从「圣园未花」移除 2 张图', async (e, ids) => {
        for (const id of ids) expect((await e.ds.getImage(id))!.characterIds.map((c) => e.back('character', c))).not.toContain('c1');
      }],
      ['exclude', () => ({ type: 'exclude' }), '已排除 2 张图', async (e, ids) => {
        for (const id of ids) expect((await e.ds.getImage(id))!.status).toBe('excluded');
      }],
      ['favorite', () => ({ type: 'favorite', value: true }), '已收藏 2 张图', async (e, ids) => {
        for (const id of ids) expect((await e.ds.getImage(id))!.favorite).toBe(true);
      }],
      ['rating', () => ({ type: 'rating', value: 'explicit' }), '已把 2 张图设为「限制级」', async (e, ids) => {
        for (const id of ids) expect((await e.ds.getImage(id))!.rating).toBe('explicit');
      }],
    ];
    for (const [title, action, message, check] of cases) {
      it(`${title}：生效、提示一致、撤销后完全还原`, async () => {
        const e = env();
        const ids = [e.id('image', 'i1'), e.id('image', 'i2')];
        const before = await snapshot(e, ids);
        const r = await e.ds.bulkImages({ ids, action: action(e) });
        expect(r.message).toBe(message);
        await check(e, ids);
        await e.ds.undo(r.undoToken!);
        expect(await snapshot(e, ids)).toEqual(before);
      });
    }

    it('restore：规则排除的和单张排除的都恢复；可撤销', async () => {
      const e = env();
      const ids = [e.id('image', 'i31'), e.id('image', 'i33')];
      const before = await snapshot(e, ids);
      const r = await e.ds.bulkImages({ ids, action: { type: 'restore' } });
      expect(r.message).toBe('已恢复 2 张图');
      for (const id of ids) expect((await e.ds.getImage(id))!.status).not.toBe('excluded');
      await e.ds.undo(r.undoToken!);
      expect(await snapshot(e, ids)).toEqual(before);
    });

    it('混进不存在的 id → 404，其他图不变', async () => {
      const e = env();
      const id = e.id('image', 'i1');
      const before = await snapshot(e, [id]);
      await expect(e.ds.bulkImages({ ids: [id, e.name === 'sqlite' ? '999999' : 'i999'], action: { type: 'favorite', value: true } })).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await snapshot(e, [id])).toEqual(before);
    });
  });
}
// ---------------------------------------------------------------- T19 撤销

export function undoContract(make: ContractFactory, name: Name) {
  contract('T19', '撤销', name, () => {
    const env = useEnv(make);

    it('撤销后状态与之前一致，并通知前端刷新', async () => {
      const e = env();
      const id = e.id('image', 'i2');
      const before = await e.ds.getImage(id);
      const res = await e.ds.updateImage(id, { favorite: true, rating: 'explicit' });
      expect(res.undoToken).toBeTruthy();
      expect((await e.ds.getImage(id))?.favorite).toBe(true);
      e.events.length = 0;
      await e.ds.undo(res.undoToken!);
      expect(await e.ds.getImage(id)).toEqual(before);
      expect(e.events.some((ev) => ev.type === 'library-changed')).toBe(true);
    });

    it('同一个 token 撤销两次 → not_found', async () => {
      const e = env();
      const res = await e.ds.updateImage(e.id('image', 'i1'), { favorite: false });
      await e.ds.undo(res.undoToken!);
      await expect(e.ds.undo(res.undoToken!)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('不存在的 token → not_found', async () => {
      await expect(env().ds.undo('no-such-token')).rejects.toMatchObject({ code: 'not_found' });
    });
  });
}

// ---------------------------------------------------------------- T27 内容类型

export function kindsContract(make: ContractFactory, name: Name) {
  contract('T27', '内容类型', name, () => {
    const env = useEnv(make);
    const ids = (e: ContractEnv, list: { id: string }[]) => list.map((i) => e.back('image', i.id));

    it('标为截图：退出未识别、计入别册与 kindCounts，状态算已处理；撤销还原', async () => {
      const e = env();
      const id = e.id('image', 'i24');
      const r = await e.ds.bulkImages({ ids: [id], action: { type: 'kind', value: 'screenshot' } });
      expect(r.message).toBe('已把 1 张图标为「截图」');
      const stats = await e.ds.getStats();
      expect(stats.unrecognizedCount).toBe(6);
      expect(stats.kindCounts).toMatchObject({ illustration: 31, screenshot: 1 });
      expect(Object.values(stats.kindCounts).reduce((a, b) => a + b, 0)).toBe(stats.imageCount);
      const img = await e.ds.getImage(id);
      expect([img?.kind, img?.status, img?.kindSource, img?.kindReason]).toEqual(['screenshot', 'recognized', 'manual', null]);
      expect(ids(e, (await e.ds.listImages({ kind: ['screenshot'] })).items)).toEqual(['i24']);
      expect((await e.ds.listImages({ kind: 'all' })).total).toBe(32);
      expect((await e.ds.listImages({ status: 'unrecognized' })).total).toBe(6);
      const u = await e.ds.listUnrecognized({});
      expect([u.total, u.annexCount]).toEqual([6, 1]);
      const kinds = await e.ds.listContentKinds();
      expect(kinds.map((k) => k.kind)).toEqual(['illustration', 'comic', 'screenshot', 'text', 'photo', 'meme', 'animated']);
      expect(kinds[2]).toMatchObject({ count: 1, recentCount: 1 });
      expect(kinds[2]!.previews.map((p) => e.back('image', p.id))).toEqual(['i24']);

      await e.ds.undo(r.undoToken!);
      const back = await e.ds.getImage(id);
      expect([back?.kind, back?.status]).toEqual(['illustration', 'unrecognized']);
      expect(back?.kindSource).not.toBe('manual');
      expect((await e.ds.getStats()).unrecognizedCount).toBe(7);
    });

    it('角色张数只数插画，其余记在 otherCount', async () => {
      const e = env();
      await e.ds.updateImage(e.id('image', 'i2'), { kind: 'comic' });
      const c1 = (await e.ds.getCharacter(e.id('character', 'c1')))!.character;
      expect([c1.imageCount, c1.otherCount]).toEqual([7, 1]);
      const w1 = (await e.ds.getWork(e.id('work', 'w1')))!;
      expect([w1.imageCount, w1.otherCount]).toEqual([15, 1]);
    });

    it('只出现在别册里的角色默认隐藏，includeOther 时列出', async () => {
      const e = env();
      await e.ds.bulkImages({ ids: [e.id('image', 'i23')], action: { type: 'kind', value: 'meme' } });
      const list = await e.ds.listCharacters({});
      expect([list.total, list.otherOnlyCount]).toEqual([6, 1]);
      const all = await e.ds.listCharacters({ includeOther: true });
      expect(all.total).toBe(7);
      expect((await e.ds.getStats()).characterCount).toBe(6);
    });

    it('恢复自动判断：回到规则判断的结果', async () => {
      const e = env();
      const id = e.id('image', 'i33'); // 带 comic 0.8 标签
      await e.ds.updateImage(id, { kind: 'photo' });
      const r = await e.ds.updateImage(id, { kind: 'auto' });
      expect(r.message).toBe('已恢复自动判断');
      const img = await e.ds.getImage(id);
      expect([img?.kind, img?.kindSource]).toEqual(['comic', 'tags']);
    });

    it('随机排序的种子：同一个种子结果相同，换种子顺序不同', async () => {
      const e = env();
      const run = async (seed: number) => ids(e, (await e.ds.listImages({ sort: 'random', seed, limit: 32 })).items);
      expect(await run(7)).toEqual(await run(7));
      expect(await run(7)).not.toEqual(await run(8));
    });

    it('rated：只要识别过或手动设过分级的图', async () => {
      const e = env();
      expect((await e.ds.listImages({ rated: true })).total).toBe(31); // i30 没识别
    });
  });
}

// ---------------------------------------------------------------- T38 合集（每条都是独立的 it，从夹具初始状态开始，RV-C-16）

export function collectionsContract(make: ContractFactory, name: Name) {
  contract('T38', '合集', name, () => {
    const env = useEnv(make);
    const img = (e: ContractEnv, x: string) => e.id('image', x);
    const ids = (e: ContractEnv, list: { id: string }[]) => list.map((i) => e.back('image', i.id));

    it('① 初始没有合集', async () => {
      const e = env();
      expect(await e.ds.listCollections({})).toEqual([]);
      const st = await e.ds.getStats();
      expect([st.collectionCounts, st.pendingCollectionCount]).toEqual([{ doujin: 0, artbook: 0 }, 0]);
    });

    it('② 把「未整理」做成画集：页退出逐张队列，成为一条待整理；撤销后恢复', async () => {
      const e = env();
      const r = await e.ds.createCollection({ fromImageId: img(e, 'i24'), kind: 'artbook' });
      expect(r.message).toBe('已把「未整理」做成画集（7 页）');
      const list = await e.ds.listCollections({});
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ title: '未整理', pageCount: 7, origin: 'manual', pending: true, unrecognizedPageCount: 7 });
      const st = await e.ds.getStats();
      expect([st.unrecognizedCount, st.pendingCollectionCount]).toEqual([0, 1]);
      expect(st.unrecognizedCount).toBeGreaterThanOrEqual(st.untaggedCount);
      expect((await e.ds.listUnrecognized({})).total).toBe(0);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getStats()).unrecognizedCount).toBe(7);
      expect(await e.ds.listCollections({})).toEqual([]);
    });

    it('③ 同一个文件夹再建 → 409', async () => {
      const e = env();
      await e.ds.createCollection({ fromImageId: img(e, 'i24'), kind: 'artbook' });
      await expect(e.ds.createCollection({ fromImageId: img(e, 'i25'), kind: 'artbook' })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('④ 页序、按合集列图、角色收录于、看图器的「收录于」', async () => {
      const e = env();
      const { collection } = await e.ds.createCollection({ fromImageId: img(e, 'i1'), kind: 'artbook' });
      expect(collection.pageCount).toBe(25);
      const detail = (await e.ds.getCollection(collection.id))!;
      expect(detail.pages.map((p) => e.back('image', p.imageId))).toEqual([
        ...Array.from({ length: 23 }, (_, i) => `i${i + 1}`).filter((x) => !['i33'].includes(x)),
        'i37',
        'i38',
      ].slice(0, 25));
      const page = await e.ds.listImages({ collectionId: collection.id, sort: 'page', order: 'asc', limit: 3 });
      expect([ids(e, page.items), page.total]).toEqual([['i1', 'i2', 'i3'], 25]);
      expect((await e.ds.listImages({ collectionId: 'none' })).total).toBe(7);
      const byChar = await e.ds.listCollections({ characterId: e.id('character', 'c7') });
      expect(byChar.map((c) => [c.id, c.matchPageCount])).toEqual([[collection.id, 1]]);
      expect((await e.ds.getImage(img(e, 'i1')))!.collection).toMatchObject({ pageNo: 1, pageCount: 25, kind: 'artbook', title: '角色' });
    });

    it('⑤ 改成本子后出场门槛变高；手动关联的角色总在', async () => {
      const e = env();
      const { collection } = await e.ds.createCollection({ fromImageId: img(e, 'i1'), kind: 'artbook' });
      await e.ds.updateCollection(collection.id, { kind: 'doujin' });
      const by = async (c: string) => (await e.ds.listCollections({ characterId: e.id('character', c) })).map((x) => x.matchPageCount);
      expect([await by('c6'), await by('c7'), await by('c1')]).toEqual([[], [], [8]]);
      await e.ds.updateCollection(collection.id, { manualCharacterIds: [e.id('character', 'c7')] });
      expect(await by('c7')).toEqual([1]);
      const cast = (await e.ds.getCollection(collection.id))!.cast;
      expect(cast.find((c) => e.back('character', c.character.id) === 'c7')?.manual).toBe(true);
    });

    it('⑥ 改名、恢复自动名', async () => {
      const e = env();
      const { collection } = await e.ds.createCollection({ fromImageId: img(e, 'i1'), kind: 'artbook' });
      await e.ds.updateCollection(collection.id, { title: '测试本' });
      expect((await e.ds.listCollections({}))[0]!.title).toBe('测试本');
      await e.ds.updateCollection(collection.id, { title: null });
      expect((await e.ds.listCollections({}))[0]!.title).toBe('角色');
    });

    it('⑦ 批量标为已整理，可撤销', async () => {
      const e = env();
      const a = (await e.ds.createCollection({ fromImageId: img(e, 'i1'), kind: 'artbook' })).collection;
      const b = (await e.ds.createCollection({ fromImageId: img(e, 'i24'), kind: 'artbook' })).collection;
      expect((await e.ds.getStats()).pendingCollectionCount).toBe(1);
      const r = await e.ds.bulkCollections({ ids: [a.id, b.id], action: { type: 'review' } });
      expect(r.message).toBe('已把 2 本标为已整理');
      expect((await e.ds.getStats()).pendingCollectionCount).toBe(0);
      await e.ds.undo(r.undoToken!);
      expect((await e.ds.getStats()).pendingCollectionCount).toBe(1);
    });

    it('⑧ 不成册，之后可以重新做成合集', async () => {
      const e = env();
      const { collection } = await e.ds.createCollection({ fromImageId: img(e, 'i1'), kind: 'artbook' });
      await e.ds.deleteCollection(collection.id);
      expect(await e.ds.listCollections({})).toEqual([]);
      expect((await e.ds.getImage(img(e, 'i1')))!.collection).toBeNull();
      const again = await e.ds.createCollection({ fromImageId: img(e, 'i1'), kind: 'doujin' });
      expect(again.collection.pageCount).toBe(25);
    });

    it('⑨ 系列', async () => {
      const e = env();
      const a = (await e.ds.createCollection({ fromImageId: img(e, 'i1'), kind: 'artbook' })).collection;
      const b = (await e.ds.createCollection({ fromImageId: img(e, 'i24'), kind: 'artbook' })).collection;
      await e.ds.updateCollection(a.id, { seriesKey: 'S', volumeNo: 1 });
      await e.ds.updateCollection(b.id, { seriesKey: 'S', volumeNo: 2 });
      expect((await e.ds.listCollections({ seriesKey: 'S' })).map((c) => c.id)).toEqual([a.id, b.id]);
      expect((await e.ds.getCollection(a.id))!.series.map((c) => c.id)).toEqual([a.id, b.id]);
      const st = await e.ds.getStats();
      expect(st.unrecognizedCount).toBeGreaterThanOrEqual(st.untaggedCount);
    });
  });
}
