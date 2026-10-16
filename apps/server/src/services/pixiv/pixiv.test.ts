import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { searchKey } from '@emaki/shared';
import { openDatabase, type Db } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { EventBus } from '../../core/events.ts';
import { JobQueue, type JobContext } from '../../core/jobs.ts';
import { UndoStack } from '../../core/undo.ts';
import { createContext } from '../../datasource/sqlite/context.ts';
import { CharacterCatalog } from '../catalog/characterCatalog.ts';
import { CopyrightResolver } from '../catalog/copyrights.ts';
import { TagResultWriter } from '../tagger/writer.ts';
import { PixivAccessError, PixivClient, type PixivArtwork } from './client.ts';
import { createPixivMatcher } from './match.ts';
import { pendingPixivCount, queuePixivImages, syncPixivCharacters } from './sync.ts';

let db: Db;
let ctx: ReturnType<typeof createContext>;
let controller: AbortController;
let job: JobContext;
const A = 'alice_(game_a)', B = 'bob_(game_b)';
const makeCatalog = () => {
  const copyrights = new CopyrightResolver(db, { [A]: ['game_a'], [B]: ['game_b'] });
  return { catalog: new CharacterCatalog(db, { copyrights }), copyrights };
};
const art = (pageCount: number, names: string[], id = '123'): PixivArtwork => ({ id, pageCount, tags: { tags: names.map((tag) => ({ tag })) } });
const links = () => db.prepare('SELECT image_id, character_id FROM image_characters ORDER BY image_id,character_id').all();
function name(tag: string, value: string, category = 4) {
  db.prepare('INSERT OR IGNORE INTO tag_i18n(tag,category) VALUES (?,?)').run(tag, category);
  db.prepare("INSERT OR IGNORE INTO tag_name_keys(search_key,tag,kind,source) VALUES (?,?,'alias','dict')").run(searchKey(value), tag);
}
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  db.exec("INSERT INTO library_roots(id,path) VALUES (1,'D:/Pictures')");
  for (let id = 1; id <= 2; id++) db.prepare(`INSERT INTO images
    (id,root_id,rel_path,file_name,width,height,bytes,format,sha256,added_at,modified_at,content_kind,source_site,source_post_id)
    VALUES (?,1,?,?,1,1,1,'png',?,'x','x','illustration','pixiv','123')`).run(id, `123_p${id-1}.png`, `123_p${id-1}.png`, `s${id}`);
  const bus = new EventBus();
  ctx = createContext({ db, bus, dataDir: '.', clock: () => 0, undo: new UndoStack(), jobs: new JobQueue(bus, () => async () => {}) });
  controller = new AbortController();
  job = { signal: controller.signal, setTotal: vi.fn(), advance: vi.fn(), setMessage: vi.fn(), shouldYield: () => false, requeue: vi.fn(), yielded: false };
  name(A, 'アリス'); name(A, 'Alice'); name(B, 'ボブ'); name('game_a', 'ゲームA', 3);
  queuePixivImages(ctx);
});
afterEach(() => db.close());

it('首次模型打标自动登记，已识别角色也能补充；重复打标不重复联网，手动可补跑', async () => {
  db.exec('DELETE FROM pixiv_character_checks');
  const {catalog,copyrights} = makeCatalog();
  const writer = new TagResultWriter(db,catalog,copyrights,{
    repo:'test',autoAcceptThreshold:0.85,characterThreshold:0.35,generalThreshold:0.35,
    afterBatchInTx:(ids)=>queuePixivImages(ctx,ids),
  });
  writer.writeBatch([{id:1,ok:true,rating:null,general:[['1girl',0.9]],character:[[A,0.99]]}]);
  expect(pendingPixivCount(ctx)).toBe(1);
  const client={artwork:vi.fn().mockResolvedValue(art(1,['ボブ']))};
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(links()).toHaveLength(2);
  expect(pendingPixivCount(ctx)).toBe(0);
  queuePixivImages(ctx,[1]);
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(client.artwork).toHaveBeenCalledTimes(1);
  // 没有匹配的投稿也只自动查询一次，手动补跑可重新登记。
  queuePixivImages(ctx,[2]);
  client.artwork.mockResolvedValue(art(1,['不存在的标签']));
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  queuePixivImages(ctx,[2]);
  expect(pendingPixivCount(ctx)).toBe(0);
  queuePixivImages(ctx);
  expect(pendingPixivCount(ctx)).toBe(1);
});

it('网络返回前改成手动角色、或文件改变，不会应用过期的自动结果', async () => {
  const client={artwork:async()=>{
    const id=makeCatalog().catalog.ensureCharacter(A,'now').id;
    db.prepare("INSERT INTO image_characters(image_id,character_id,origin,added_at) VALUES (1,?,'manual','now')").run(id);
    db.exec("UPDATE images SET modified_at='new-file' WHERE id=2");
    return art(1,['ボブ']);
  }};
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(links()).toHaveLength(1);
  expect(db.prepare('SELECT * FROM character_suggestions').all()).toHaveLength(0);
});

it.each([
  [1, ['アリス'], true, 2],
  [1, ['アリス', 'ボブ'], true, 4],
  [3, ['アリス', 'Alice'], true, 2],
  [3, ['アリス', 'ボブ'], false, 4],
])('页数 %i 标签 %j 的关联规则', async (pages, tags, automatic, count) => {
  const client = { artwork: vi.fn().mockResolvedValue(art(pages, tags)) };
  await syncPixivCharacters(ctx, job, makeCatalog, client, 0);
  expect(client.artwork).toHaveBeenCalledTimes(1);
  expect(links()).toHaveLength(automatic ? count : 0);
  expect(db.prepare('SELECT * FROM character_suggestions').all()).toHaveLength(automatic ? 0 : count);
  await syncPixivCharacters(ctx, job, makeCatalog, client, 0);
  expect(links()).toHaveLength(automatic ? count : 0);
  expect(db.prepare('SELECT * FROM character_suggestions').all()).toHaveLength(automatic ? 0 : count);
});

it('只有一张本地图片也按投稿总页数生成多角色建议', async () => {
  db.exec('DELETE FROM images WHERE id=2');
  await syncPixivCharacters(ctx, job, makeCatalog, { artwork: async () => art(8, ['アリス', 'ボブ']) }, 0);
  expect(links()).toHaveLength(0);
  expect(db.prepare('SELECT * FROM character_suggestions').all()).toHaveLength(2);
});

it('翻译里的服饰普通词与角色同名时不会误关联；原文匹配优先于翻译', () => {
  name('kneesocks_(psg)', 'kneesocks');
  name('kneehighs', 'kneesocks', 0);
  const {catalog,copyrights} = makeCatalog();
  const match=createPixivMatcher(db,catalog,copyrights);
  expect(match({id:'123',pageCount:1,tags:{tags:[{tag:'ニーソ',translation:{en:'kneesocks'}},{tag:'アリス',translation:{en:'ボブ'}}]}}))
    .toEqual({tags:[A],automatic:true});
});

it('有歧义只建议，作品标签可消歧，普通标签/局部名称不会匹配', () => {
  name(B, 'Alice');
  const { catalog, copyrights } = makeCatalog();
  const match = createPixivMatcher(db, catalog, copyrights);
  expect(match(art(1, ['Alice']))).toEqual({ tags: [A, B], automatic: false });
  expect(match(art(1, ['Alice', 'ゲームA']))).toEqual({ tags: [A], automatic: true });
  expect(match(art(1, ['白髪', 'アリス誕生日'])) .tags).toEqual([]);
});

it('写入前重查队列，忽略截图、已处理和请求期间用户改动的图片', async () => {
  db.exec("UPDATE images SET content_kind='screenshot' WHERE id=2");
  const client = { artwork: async () => {
    db.exec("UPDATE images SET original_at='now' WHERE id=1");
    return art(1, ['アリス']);
  } };
  await syncPixivCharacters(ctx, job, makeCatalog, client, 0);
  expect(links()).toHaveLength(0);
});

it('取消请求后不再写入，访问受限报告失败', async () => {
  await expect(syncPixivCharacters(ctx, job, makeCatalog, { artwork: async () => {
    controller.abort(); return art(1, ['アリス']);
  } }, 0)).rejects.toThrow();
  expect(links()).toHaveLength(0);
});

it('Pixiv 建议不会因模型阈值设为零被自动提升，重新识别仍保留来源候选', async () => {
  await syncPixivCharacters(ctx, job, makeCatalog, { artwork: async () => art(2, ['アリス','ボブ']) }, 0);
  const { catalog, copyrights } = makeCatalog();
  const writer = new TagResultWriter(db, catalog, copyrights, { repo:'test', autoAcceptThreshold:0, characterThreshold:0, generalThreshold:0 });
  expect(writer.promoteSuggestions()).toBe(0);
  writer.writeBatch([{id:1,ok:true,rating:null,general:[],character:[]}]);
  expect(db.prepare("SELECT * FROM character_suggestions WHERE source='pixiv'").all()).toHaveLength(4);
});

it('解析 Pixiv 响应、校验 ID；404 跳过，403 不重试', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ status:200, text:async () => JSON.stringify({error:false,body:art(2,['アリス'])}),headers:{get:()=>null} });
  const client = new PixivClient(fetchImpl);
  expect((await client.artwork('123',controller.signal))?.pageCount).toBe(2);
  await expect(client.artwork('456',controller.signal)).rejects.toThrow('ID');
  fetchImpl.mockResolvedValue({status:404,text:async()=>'',headers:{get:()=>null}});
  expect(await client.artwork('123',controller.signal)).toBeNull();
  fetchImpl.mockResolvedValue({status:403,text:async()=>'',headers:{get:()=>null}});
  await expect(client.artwork('123',controller.signal)).rejects.toBeInstanceOf(PixivAccessError);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});
