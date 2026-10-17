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

it('404 按投稿持久记忆，补跑和同投稿新图片不重复联网，换投稿仍可检查', async () => {
  const client={artwork:vi.fn().mockResolvedValue(null)};
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(db.prepare('SELECT post_id FROM pixiv_unavailable_posts').pluck().all()).toEqual(['123']);
  queuePixivImages(ctx);
  db.exec('DELETE FROM pixiv_character_checks WHERE image_id=2');
  queuePixivImages(ctx,[2]);
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(client.artwork).toHaveBeenCalledTimes(1);
  expect(pendingPixivCount(ctx)).toBe(0);
  db.exec("UPDATE images SET source_post_id='456' WHERE id=2");
  queuePixivImages(ctx,[2]);
  client.artwork.mockResolvedValue(art(1,['アリス'],'456'));
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(client.artwork).toHaveBeenCalledTimes(2);
  expect(links()).toHaveLength(1);
});

it('连接失败不记为投稿不存在，补跑可以恢复', async () => {
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>{throw new Error('timeout');}},0);
  expect(db.prepare('SELECT COUNT(*) FROM pixiv_unavailable_posts').pluck().get()).toBe(0);
  expect(pendingPixivCount(ctx)).toBe(2);
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(1,['アリス'])},0);
  expect(links()).toHaveLength(2);
});

it('首次模型低置信度候选自动登记，页面角色不同仍可关联；重复打标不重复联网', async () => {
  db.exec('DELETE FROM pixiv_character_checks');
  const {catalog,copyrights} = makeCatalog();
  const writer = new TagResultWriter(db,catalog,copyrights,{
    repo:'test',autoAcceptThreshold:0.85,characterThreshold:0.35,generalThreshold:0.35,
    afterBatchInTx:(ids)=>queuePixivImages(ctx,ids),
  });
  writer.writeBatch([{id:1,ok:true,rating:null,general:[['1girl',0.9]],character:[[A,0.79]]}]);
  expect(pendingPixivCount(ctx)).toBe(1);
  const client={artwork:vi.fn().mockResolvedValue(art(1,['ボブ']))};
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(links()).toHaveLength(1);
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

it('访问受限保留待补队列，恢复后无需重新登记即可续跑', async () => {
  await expect(syncPixivCharacters(ctx, job, makeCatalog, { artwork: async () => {
    throw new PixivAccessError('429');
  } }, 0)).rejects.toThrow('429');
  expect(pendingPixivCount(ctx)).toBe(2);
  await syncPixivCharacters(ctx, job, makeCatalog, { artwork: async () => art(1, ['アリス']) }, 0);
  expect(links()).toHaveLength(2);
  expect(pendingPixivCount(ctx)).toBe(0);
});

it('同一标签的译名可消除原文别名歧义，不把真正的多角色合并', () => {
  name(B, 'アリス');
  const {catalog,copyrights} = makeCatalog();
  const match=createPixivMatcher(db,catalog,copyrights);
  const artwork: PixivArtwork = {id:'123',pageCount:19,tags:{tags:[{tag:'アリス',translation:{en:'Alice'}}]}};
  expect(match(artwork)).toEqual({tags:[A],automatic:true});
  artwork.tags.tags.push({tag:'ボブ'});
  expect(match(artwork)).toEqual({tags:[A,B],automatic:false});
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


it('cosplay 普通标签不会屏蔽角色本名，实际 cosplay 标签仍不认角色', () => {
  name('alice_(game_a)_(cosplay)', 'Alice', 0);
  const {catalog,copyrights}=makeCatalog();const match=createPixivMatcher(db,catalog,copyrights);
  expect(match(art(1,['Alice'])).tags).toEqual([A]);
  expect(match(art(1,['alice_(game_a)_(cosplay)'])).tags).toEqual([]);
  expect(match(art(1,['アリス(コスプレ)'])).tags).toEqual([]);
});

it('明确的原文角色名不会被普通译名屏蔽，单独的普通词仍不认角色', () => {
  name('iris_(flower)','Iris',0); name(A,'Iris');
  const {catalog,copyrights}=makeCatalog();const match=createPixivMatcher(db,catalog,copyrights);
  expect(match({id:'123',pageCount:2,tags:{tags:[{tag:'アリス',translation:{en:'Iris'}}]}})).toEqual({tags:[A],automatic:true});
  expect(match(art(1,['Iris'])).tags).toEqual([]);
});

it.each([0.79,0.8,0.95])('模型候选分数 %f 仅在低于80%时允许页面关联不同角色', async score => {
  db.exec('DELETE FROM pixiv_character_checks');
  db.prepare("INSERT INTO character_suggestions(image_id,danbooru_tag,score,source) VALUES (1,?,?,'tagger')").run(A,score);
  queuePixivImages(ctx,[1]);
  const client={artwork:vi.fn().mockResolvedValue(art(3,['ボブ']))};
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(links()).toHaveLength(score<0.8?1:0);
  if(score<0.8) expect(db.prepare('SELECT c.danbooru_tag FROM image_characters ic JOIN characters c ON c.id=ic.character_id WHERE ic.image_id=1').pluck().get()).toBe(B);
  else expect(client.artwork).not.toHaveBeenCalled();
});

it('已有模型关联不登记，联网期间新增模型关联也不追加', async () => {
  const id=makeCatalog().catalog.ensureCharacter(A,'now').id;
  db.prepare("INSERT INTO image_characters(image_id,character_id,origin,score,added_at) VALUES (1,?,'tagger',0.9,'now')").run(id);
  expect(pendingPixivCount(ctx)).toBe(1);
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>{
    db.prepare("INSERT INTO image_characters(image_id,character_id,origin,score,added_at) VALUES (2,?,'tagger',0.9,'now')").run(id);
    return art(1,['ボブ']);
  }},0);
  expect(links()).toHaveLength(2);
  expect(db.prepare('SELECT COUNT(DISTINCT character_id) FROM image_characters').pluck().get()).toBe(1);
});


it('复用 wiki 别名同步后能匹配新日文名，已获取的条目不重复请求', async () => {
  const {refreshPixivAliases}=await import('./aliases.ts');
  const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  db.prepare("INSERT INTO danbooru_tags(name,category,post_count,fetched_at) VALUES (?,4,1,'now')").run(A);
  const catalog=new DanbooruCatalog(db,makeCatalog().copyrights);
  const client={wikiByTitles:vi.fn().mockResolvedValue([{title:A,other_names:['新しい別名'],is_deleted:false}])};
  await refreshPixivAliases(db,catalog,client,job);
  await refreshPixivAliases(db,catalog,client,job);
  expect(client.wikiByTitles).toHaveBeenCalledTimes(1);
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(2,['新しい別名'])},0);
  expect(links()).toHaveLength(2);
});

it('wiki 请求取消不写入完成标记，失败后可以再次补全', async () => {
  const {refreshPixivAliases}=await import('./aliases.ts');
  const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  db.prepare("INSERT INTO danbooru_tags(name,category,post_count,fetched_at) VALUES (?,4,1,'now')").run(A);
  const catalog=new DanbooruCatalog(db,makeCatalog().copyrights);
  await expect(refreshPixivAliases(db,catalog,{wikiByTitles:async()=>{controller.abort();return [];}},job)).rejects.toThrow();
  expect(db.prepare('SELECT wiki_fetched_at FROM danbooru_tags WHERE name=?').pluck().get(A)).toBeNull();
});

it('在线精确确认的新角色可建档并关联，普通标签和模糊结果不采纳', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts');
  const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const dan=new DanbooruCatalog(db,makeCatalog().copyrights);
  const tag='new_character_(test)';
  const client={autocomplete:vi.fn().mockImplementation(async(q:string)=>q==='未知角色名'?[{type:'tag',category:4,value:tag,antecedent:q}]:[{type:'tag',category:0,value:'ordinary_word',antecedent:q}]),
    tagsByNames:vi.fn().mockResolvedValue([{name:tag,category:4,post_count:1,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]}]),
    wikiByTitles:vi.fn().mockResolvedValue([{title:tag,other_names:['未知角色名'],is_deleted:false}])};
  const discover=createPixivDiscovery(db,dan,client);
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(3,['未知角色名','普通描述'])},0,discover);
  expect(links()).toHaveLength(2);
  expect(db.prepare('SELECT danbooru_tag FROM characters').pluck().all()).toEqual([tag]);
});

it('在线未确认名称不造角色，也不把未知标签列为建议', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts');const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const client={autocomplete:vi.fn().mockResolvedValue([{type:'tag',category:4,value:'different_name'}]),tagsByNames:vi.fn(),wikiByTitles:vi.fn()};
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(1,['未知名字'])},0,createPixivDiscovery(db,new DanbooruCatalog(db,makeCatalog().copyrights),client));
  expect(summary).toContain('未匹配角色 1');expect(links()).toHaveLength(0);expect(client.tagsByNames).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0);
  const {loadSuggestions}=await import('../../datasource/sqlite/suggestions.ts');
  expect(loadSuggestions(ctx,[1],makeCatalog().catalog).get(1)).toBeUndefined();
});

it('明确原创字段映射到原创状态和作品，重复运行不重复写入', async () => {
  const client={artwork:vi.fn().mockResolvedValue({...art(2,['普通标签']),isOriginal:true})};
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(summary).toContain('原创 2 张');
  expect(db.prepare('SELECT COUNT(*) FROM images WHERE original_at IS NOT NULL').pluck().get()).toBe(2);
  expect(db.prepare("SELECT COUNT(*) FROM image_copyrights ic JOIN works w ON w.id=ic.work_id WHERE w.danbooru_tag='original'").pluck().get()).toBe(2);
  expect(links()).toHaveLength(0);
  queuePixivImages(ctx);
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(client.artwork).toHaveBeenCalledTimes(1);
});

it.each([false,undefined])('原创字段 %s 不会设置原创状态', async isOriginal => {
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>({...art(2,[]),isOriginal})},0);
  expect(db.prepare('SELECT COUNT(*) FROM images WHERE original_at IS NOT NULL').pluck().get()).toBe(0);
});

it('原创标记仍保护已有角色和80%以上候选', async () => {
  const character=makeCatalog().catalog.ensureCharacter(A,'now');
  db.prepare("INSERT INTO image_characters(image_id,character_id,origin,added_at) VALUES (1,?,'manual','now')").run(character.id);
  db.prepare("INSERT INTO character_suggestions(image_id,danbooru_tag,score,source) VALUES (2,?,0.8,'tagger')").run(B);
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>({...art(2,[]),isOriginal:true})},0);
  expect(db.prepare('SELECT COUNT(*) FROM images WHERE original_at IS NOT NULL').pluck().get()).toBe(0);
});

it('陌生名称在线查询失败时保留队列，不写半成品建议', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts');const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const discover=createPixivDiscovery(db,new DanbooruCatalog(db,makeCatalog().copyrights),{
    autocomplete:async()=>{throw new Error('offline');},tagsByNames:vi.fn(),wikiByTitles:vi.fn(),
  });
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(1,['未知名字'])},0,discover);
  expect(summary).toContain('失败 1');
  expect(pendingPixivCount(ctx)).toBe(2);
  expect(db.prepare('SELECT COUNT(*) FROM character_suggestions').pluck().get()).toBe(0);
});

it('自定义原创角色可按名字关联，多角色投稿的建议显示真实名字', async () => {
  const ids=['原创角色甲','原创角色乙'].map(n=>Number(db.prepare("INSERT INTO characters(name,source,created_at) VALUES (?,'custom','now')").run(n).lastInsertRowid));
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(3,['原创角色甲','原创角色乙'])},0);
  expect(links()).toHaveLength(0);
  const {loadSuggestions}=await import('../../datasource/sqlite/suggestions.ts');
  expect(loadSuggestions(ctx,[1],makeCatalog().catalog).get(1)?.map(s=>s.name)).toEqual(['原创角色甲','原创角色乙']);
  queuePixivImages(ctx);
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(3,['原创角色甲'])},0);
  expect(links()).toEqual([{image_id:1,character_id:ids[0]},{image_id:2,character_id:ids[0]}]);
  expect(db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(2);
});

it('只含普通词或原创字样不会创建角色，也不会代替用户执行归为原创', async () => {
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(2,['オリジナル','少女','皮鞋'])},0);
  expect(summary).toContain('未匹配角色 1');expect(links()).toHaveLength(0);
  expect(db.prepare('SELECT COUNT(*) FROM images WHERE original_at IS NOT NULL').pluck().get()).toBe(0);
});

it('在线补充同角色不同别名时保留此前已确认的名称', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts');
  const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const catalog=new DanbooruCatalog(db,makeCatalog().copyrights);
  const tag='new_character_(test)';
  const discover=createPixivDiscovery(db,catalog,{
    autocomplete:async query=>[{type:'tag',category:4,value:tag,antecedent:query}],
    tagsByNames:async()=>[{name:tag,category:4,post_count:1,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]}],
    wikiByTitles:async()=>[],
  });
  await discover(art(1,['新名甲']),controller.signal);
  await discover(art(1,['新名乙']),controller.signal);
  expect(catalog.get(tag)?.otherNames).toEqual(['新名甲','新名乙']);
});

it('投稿查询部分失败后，后续投稿仍能使用已写入的角色索引', async () => {
  db.exec("UPDATE images SET source_post_id='456' WHERE id=2");
  queuePixivImages(ctx);
  const discover=vi.fn().mockImplementationOnce(async()=>{
    name(A,'新别名');
    throw new Error('later request failed');
  }).mockResolvedValue({changed:false});
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async id=>art(1,['新别名'],id)},0,discover);
  expect(summary).toContain('失败 1');
  expect(links()).toHaveLength(1);
  expect(links()[0]).toMatchObject({image_id:2});
  expect(pendingPixivCount(ctx)).toBe(1);
});
