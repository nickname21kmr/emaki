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
import { pendingPixivCount, queuePixivImages, resetPixivBackoff, syncPixivCharacters } from './sync.ts';

let db: Db;
let ctx: ReturnType<typeof createContext>;
let controller: AbortController;
let job: JobContext;
const A = 'alice_(game_a)', B = 'bob_(game_b)';
const makeCatalog = () => {
  const copyrights = new CopyrightResolver(db, { [A]: ['game_a'], [B]: ['game_b'] });
  return { catalog: new CharacterCatalog(db, { copyrights }), copyrights };
};
// 默认带上两部作品的标签：自动关联要靠投稿里的作品标签确认角色
const art = (pageCount: number, names: string[], id = '123', works = ['ゲームA', 'ゲームB']): PixivArtwork =>
  ({ id, pageCount, tags: { tags: [...names, ...works].map((tag) => ({ tag })) } });
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
  name(A, 'アリス'); name(A, 'Alice'); name(B, 'ボブ'); name('game_a', 'ゲームA', 3); name('game_b', 'ゲームB', 3);
  resetPixivBackoff();
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
  // 退避期内自动补充不再挑它；手动补跑清掉退避后仍是待补
  expect(pendingPixivCount(ctx)).toBe(0);
  resetPixivBackoff();
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
  expect(match({id:'123',pageCount:1,tags:{tags:[{tag:'ニーソ',translation:{en:'kneesocks'}},{tag:'アリス',translation:{en:'ボブ'}},{tag:'ゲームA'}]}}))
    .toEqual({tags:[A],automatic:true});
});

it('有歧义只建议，作品标签可消歧，普通标签/局部名称不会匹配', () => {
  name(B, 'Alice');
  const { catalog, copyrights } = makeCatalog();
  const match = createPixivMatcher(db, catalog, copyrights);
  expect(match(art(1, ['Alice'], '123', []))).toEqual({ tags: [A, B], automatic: false });
  expect(match(art(1, ['Alice', 'ゲームA'], '123', []))).toEqual({ tags: [A], automatic: true });
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
  const artwork: PixivArtwork = {id:'123',pageCount:19,tags:{tags:[{tag:'アリス',translation:{en:'Alice'}},{tag:'ゲームA'}]}};
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
  // 只有 Pixiv 自己的 {error:true} 才算作品不存在（原来空响应体的 404 也算，现在按失败处理）
  fetchImpl.mockResolvedValue({status:404,text:async()=>JSON.stringify({error:true,message:'x',body:[]}),headers:{get:()=>null}});
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
  expect(match({id:'123',pageCount:2,tags:{tags:[{tag:'アリス',translation:{en:'Iris'}},{tag:'ゲームA'}]}})).toEqual({tags:[A],automatic:true});
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
  // 括号里是已知作品，投稿里的作品标签能确认它
  const tag='new_character_(game_a)';
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
  const client={autocomplete:vi.fn().mockResolvedValue([{type:'tag',category:4,value:'different_name'}]),
    tagsByNames:vi.fn().mockResolvedValue([{name:'different_name',category:4,post_count:1,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]}]),
    wikiByTitles:vi.fn().mockResolvedValue([{title:'different_name',other_names:['另一个名字'],is_deleted:false}])};
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(1,['未知名字'])},0,createPixivDiscovery(db,new DanbooruCatalog(db,makeCatalog().copyrights),client));
  expect(summary).toContain('未匹配角色 1');expect(links()).toHaveLength(0);expect(client.wikiByTitles).toHaveBeenCalled();
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
  resetPixivBackoff();
  expect(pendingPixivCount(ctx)).toBe(2);
  expect(db.prepare('SELECT COUNT(*) FROM character_suggestions').pluck().get()).toBe(0);
});

it('自定义原创角色可按名字关联，多角色投稿的建议显示真实名字', async () => {
  const ids=['原创角色甲','原创角色乙'].map(n=>Number(db.prepare("INSERT INTO characters(name,source,created_at) VALUES (?,'custom','now')").run(n).lastInsertRowid));
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>art(3,['原创角色甲','原创角色乙'])},0);
  expect(links()).toHaveLength(0);
  const {loadSuggestions}=await import('../../datasource/sqlite/suggestions.ts');
  expect(loadSuggestions(ctx,[1],makeCatalog().catalog).get(1)?.map(s=>s.name)).toEqual(['原创角色甲','原创角色乙']);
  // 自建角色的建议带真外键
  expect(db.prepare("SELECT danbooru_tag,character_id FROM character_suggestions WHERE image_id=1 ORDER BY character_id").all())
    .toEqual(ids.map((id)=>({danbooru_tag:`emaki:character:${id}`,character_id:id})));
  // 给过建议的投稿，手动补跑不再重查；文件换了才重查
  queuePixivImages(ctx);
  expect(pendingPixivCount(ctx)).toBe(0);
  db.exec("UPDATE images SET modified_at='y'");
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
  addImage(3,'100'); // 最先查，把索引建起来
  queuePixivImages(ctx);
  const discover=vi.fn().mockResolvedValueOnce({changed:false})
    .mockImplementationOnce(async(_a:PixivArtwork,_s:AbortSignal,onAdded?:(tags:string[])=>void)=>{
      name(A,'新别名'); onAdded?.([A]);
      throw new Error('later request failed');
    }).mockResolvedValue({changed:false});
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async id=>art(1,[id==='100'?'アリス':'新别名'],id)},0,discover);
  expect(summary).toContain('失败 1');
  expect(links()).toMatchObject([{image_id:2},{image_id:3}]);
  resetPixivBackoff();
  expect(pendingPixivCount(ctx)).toBe(1);
});

it('同道有更急的任务时一开始就让出：不发请求，待补保留', async () => {
  const client={artwork:vi.fn()};
  const summary=await syncPixivCharacters(ctx,{...job,shouldYield:()=>true},makeCatalog,client,0);
  expect(job.requeue).toHaveBeenCalledTimes(1);
  expect(client.artwork).not.toHaveBeenCalled();
  expect(summary).toContain('已让出');
  expect(pendingPixivCount(ctx)).toBe(2);
});

it('查完一个投稿后让出，让出前先等够间隔，续跑只查剩下的', async () => {
  db.exec("UPDATE images SET source_post_id='456' WHERE id=2");
  queuePixivImages(ctx);
  let requestedAt=0, checkedAt=0;
  const client={artwork:vi.fn().mockImplementation(async(id:string)=>{requestedAt=performance.now();return art(1,['アリス'],id);})};
  const shouldYield=vi.fn().mockReturnValueOnce(false).mockImplementation(()=>{checkedAt=performance.now();return true;});
  await syncPixivCharacters(ctx,{...job,shouldYield},makeCatalog,client,50);
  expect(client.artwork.mock.calls.map(c=>c[0])).toEqual(['123']);
  expect(checkedAt-requestedAt).toBeGreaterThanOrEqual(40);
  expect(job.requeue).toHaveBeenCalledTimes(1);
  expect(pendingPixivCount(ctx)).toBe(1);
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(client.artwork.mock.calls.map(c=>c[0])).toEqual(['123','456']);
  expect(pendingPixivCount(ctx)).toBe(0);
});

it('补别名时有更急的任务就让出，没补的留到下一轮', async () => {
  const {refreshPixivAliases}=await import('./aliases.ts');
  const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const insert=db.prepare("INSERT INTO danbooru_tags(name,category,post_count,fetched_at) VALUES (?,4,1,'now')");
  for(let n=0;n<150;n++) insert.run(`c${String(n).padStart(3,'0')}_(game_a)`);
  const client={wikiByTitles:vi.fn().mockResolvedValue([])};
  await refreshPixivAliases(db,new DanbooruCatalog(db,makeCatalog().copyrights),client,{...job,shouldYield:vi.fn().mockReturnValueOnce(false).mockReturnValue(true)});
  expect(client.wikiByTitles).toHaveBeenCalledTimes(1);
  expect(job.requeue).toHaveBeenCalledTimes(1);
  expect(db.prepare('SELECT COUNT(*) FROM danbooru_tags WHERE wiki_fetched_at IS NULL').pluck().get()).toBe(50);
});

it('只有投稿里的作品标签能确认的角色才自动关联；自建角色不用确认', () => {
  const custom=Number(db.prepare("INSERT INTO characters(name,source,created_at) VALUES ('ミドリ','custom','now')").run().lastInsertRowid);
  const {catalog,copyrights}=makeCatalog();const match=createPixivMatcher(db,catalog,copyrights);
  expect(match(art(1,['アリス'],'1',[]))).toEqual({tags:[A],automatic:false});
  expect(match(art(1,['アリス'],'1',['ゲームB']))).toEqual({tags:[A],automatic:false});
  expect(match(art(1,['アリス'],'1',['ゲームA']))).toEqual({tags:[A],automatic:true});
  // 一个确认了、一个没确认：整篇只给建议
  expect(match(art(1,['アリス','ボブ'],'1',['ゲームA'])).automatic).toBe(false);
  // Pixiv 标了原创：Danbooru 角色只建议，自建角色照样关联
  expect(match({...art(1,['アリス'],'1',['ゲームA']),isOriginal:true}).automatic).toBe(false);
  expect(match({...art(1,['ミドリ'],'1',[]),isOriginal:true})).toEqual({tags:[`emaki:character:${custom}`],automatic:true});
});

it('原创投稿撞上 Danbooru 角色名：归为原创、只给建议，不新建角色', async () => {
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>({...art(1,['アリス']),isOriginal:true})},0);
  expect(summary).toContain('原创 2 张');
  expect(links()).toHaveLength(0);
  expect(db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0);
  expect(db.prepare("SELECT danbooru_tag,character_id FROM character_suggestions WHERE source='pixiv' AND image_id=1").all())
    .toEqual([{danbooru_tag:A,character_id:null}]);
});

it('用户撤掉的 Pixiv 关联和原创，手动补跑不再写回；未匹配的投稿仍会重查', async () => {
  db.exec("UPDATE images SET source_post_id='456' WHERE id=2");
  addImage(3,'789');
  queuePixivImages(ctx);
  const client={artwork:vi.fn().mockImplementation(async(id:string)=>
    id==='123'?art(1,['アリス'],id):id==='456'?{...art(1,[],id),isOriginal:true}:art(1,['不认识的名字'],id))};
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(links()).toMatchObject([{image_id:1}]);
  expect(db.prepare('SELECT image_id,result FROM pixiv_character_checks ORDER BY image_id').all())
    .toEqual([{image_id:1,result:'linked'},{image_id:2,result:'original'},{image_id:3,result:'unmatched'}]);
  // 从角色移除、移出原创
  db.exec('DELETE FROM image_characters; UPDATE images SET original_at=NULL WHERE id=2; DELETE FROM image_copyrights WHERE image_id=2');
  queuePixivImages(ctx);
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(client.artwork.mock.calls.map(c=>c[0])).toEqual(['123','456','789','789']);
  expect(links()).toHaveLength(0);
  expect(db.prepare('SELECT COUNT(*) FROM images WHERE original_at IS NOT NULL').pluck().get()).toBe(0);
});

it('请求失败的投稿进退避：之后的自动补充不再请求，手动补跑清掉退避后重试', async () => {
  const client={artwork:vi.fn().mockRejectedValueOnce(new Error('Pixiv 请求失败（500）')).mockResolvedValue(art(1,['アリス']))};
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(pendingPixivCount(ctx)).toBe(0);
  queuePixivImages(ctx,[1,2]); // 识别又写了一批（自动路径）
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(client.artwork).toHaveBeenCalledTimes(1);
  resetPixivBackoff();
  await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(client.artwork).toHaveBeenCalledTimes(2);
  expect(links()).toHaveLength(2);
});

it('Pixiv 明确拒绝的投稿跳过接着查，不算连续失败；自动补充不再请求，手动补跑重试', async () => {
  db.exec("UPDATE images SET source_post_id='100' WHERE id=1; UPDATE images SET source_post_id='200' WHERE id=2");
  addImage(3,'300'); addImage(4,'400');
  queuePixivImages(ctx);
  const reply=(status:number,body:unknown)=>({status,headers:{get:()=>null},text:async()=>JSON.stringify(body)});
  const fetchImpl=vi.fn().mockImplementation(async(url:string)=>{
    const id=url.split('/').pop()!;
    if(id==='100') return reply(200,{error:true,message:'',body:[]});
    if(id==='200'||id==='300') return reply(400,{error:true,message:'',body:[]});
    return reply(200,{error:false,body:art(1,['アリス'],id)});
  });
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,new PixivClient(fetchImpl),0);
  expect(summary).toContain('失败 3');
  expect(links()).toMatchObject([{image_id:4}]);
  expect(db.prepare("SELECT COUNT(*) FROM pixiv_character_checks WHERE result='skipped'").pluck().get()).toBe(3);
  expect(db.prepare('SELECT COUNT(*) FROM pixiv_unavailable_posts').pluck().get()).toBe(0);
  expect(pendingPixivCount(ctx)).toBe(0);
  queuePixivImages(ctx);
  expect(pendingPixivCount(ctx)).toBe(3);
});

it('在线发现的新角色增量补进已建好的索引，同一轮后面的投稿就能认出', async () => {
  db.exec("UPDATE images SET source_post_id='456' WHERE id=2");
  queuePixivImages(ctx);
  const {createPixivDiscovery}=await import('./discovery.ts');
  const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const tag='new_character_(game_a)';
  const discover=createPixivDiscovery(db,new DanbooruCatalog(db,makeCatalog().copyrights),{
    autocomplete:vi.fn().mockImplementation(async(q:string)=>q==='新角色'?[{type:'tag',category:4,value:tag,antecedent:q}]:[]),
    tagsByNames:vi.fn().mockResolvedValue([{name:tag,category:4,post_count:1,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]}]),
    wikiByTitles:vi.fn().mockResolvedValue([]),
  });
  const mk=vi.fn(makeCatalog);
  await syncPixivCharacters(ctx,job,mk,{artwork:async(id:string)=>art(1,[id==='123'?'アリス':'新角色'],id)},0,discover);
  expect(db.prepare('SELECT ic.image_id,c.danbooru_tag FROM image_characters ic JOIN characters c ON c.id=ic.character_id ORDER BY ic.image_id').all())
    .toEqual([{image_id:1,danbooru_tag:A},{image_id:2,danbooru_tag:tag}]);
  // 索引只建一次，加上每个投稿写入前各取一次目录
  expect(mk).toHaveBeenCalledTimes(3);
});

it('任务期间自建角色被合并、编号被新角色占用：重建索引再匹配，关联到合并后的角色', async () => {
  db.exec("UPDATE images SET source_post_id='456' WHERE id=2");
  queuePixivImages(ctx);
  const ins=db.prepare("INSERT INTO characters(name,source,created_at) VALUES (?,'custom','now')");
  const y=Number(ins.run('ミドリ本体').lastInsertRowid), x=Number(ins.run('ミドリ').lastInsertRowid);
  const client={artwork:async(id:string)=>{
    if(id==='456'){
      // 按 merge 的做法：目标加别名，再删掉被合并的；随后识别新建的 Danbooru 角色占用了空出来的编号
      db.prepare("INSERT INTO aliases(owner_type,owner_id,alias,search_key) VALUES ('character',?,'ミドリ',?)").run(y,searchKey('ミドリ'));
      db.prepare('DELETE FROM characters WHERE id=?').run(x);
      expect(makeCatalog().catalog.ensureCharacter(B,'now').id).toBe(x);
    }
    // 第一个投稿没匹配上，只把索引建起来（不新建角色，x 才是最大编号）
    return art(1,[id==='123'?'不认识的名字':'ミドリ'],id);
  }};
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,client,0);
  expect(summary).toContain('失败 0');
  expect(links()).toEqual([{image_id:2,character_id:y}]);
});

it('Danbooru 连不上不算 Pixiv 失败：这轮停用在线发现，本地认得的角色照样关联', async () => {
  db.exec("UPDATE images SET source_post_id='456' WHERE id=2");
  queuePixivImages(ctx);
  const {createPixivDiscovery}=await import('./discovery.ts');
  const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const {DanbooruError}=await import('../danbooru/client.ts');
  const autocomplete=vi.fn().mockRejectedValue(new DanbooruError('被 Cloudflare 拦截','blocked',403));
  const discover=createPixivDiscovery(db,new DanbooruCatalog(db,makeCatalog().copyrights),{autocomplete,tagsByNames:vi.fn(),wikiByTitles:vi.fn()});
  const client={artwork:vi.fn().mockImplementation(async(id:string)=>art(1,['アリス','未知名字'],id))};
  const summary=await syncPixivCharacters(ctx,job,makeCatalog,client,0,discover);
  expect(summary).toContain('失败 0');
  expect(summary).toContain('Danbooru 连不上');
  expect(links()).toHaveLength(2);
  expect(autocomplete).toHaveBeenCalledTimes(1);
  expect(client.artwork).toHaveBeenCalledTimes(2);
  expect(pendingPixivCount(ctx)).toBe(0);
});

function addImage(id: number, post: string) {
  db.prepare(`INSERT INTO images
    (id,root_id,rel_path,file_name,width,height,bytes,format,sha256,added_at,modified_at,content_kind,source_site,source_post_id)
    VALUES (?,1,?,?,1,1,1,'png',?,'x','x','illustration','pixiv',?)`).run(id, `${post}_p${id}.png`, `${post}_p${id}.png`, `s${id}`, post);
}

it('未知原文不会被已知但无关的译名挡住，wiki 精确别名可以验证召回候选', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const tag='new_person_(game_a)';
  const autocomplete=vi.fn(async () => [{type:'tag',category:4,value:tag}]);
  const discover=createPixivDiscovery(db,new DanbooruCatalog(db,makeCatalog().copyrights),{
    autocomplete,
    tagsByNames:async()=>[{name:tag,category:4,post_count:12,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]}],
    wikiByTitles:async()=>[{title:tag,other_names:['新人物の原名'],is_deleted:false}],
  });
  const artwork={...art(2,[]),tags:{tags:[{tag:'新人物の原名',translation:{en:'Alice'}},{tag:'ゲームA'}]}};
  await syncPixivCharacters(ctx,job,makeCatalog,{artwork:async()=>artwork},0,discover);
  expect(autocomplete).toHaveBeenCalledWith('新人物の原名',controller.signal);
  expect(db.prepare('SELECT c.danbooru_tag FROM image_characters ic JOIN characters c ON c.id=ic.character_id').pluck().all()).toEqual([tag,tag]);
});

it('已知普通译名沿用本地跳过，不为每个普通标签增加联网查询', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  name('blue_hair','blue hair',0);
  const client={autocomplete:vi.fn(),tagsByNames:vi.fn(),wikiByTitles:vi.fn()};
  const artwork={...art(1,[]),tags:{tags:[{tag:'青い髪',translation:{en:'blue hair'}}]}};
  await createPixivDiscovery(db,new DanbooruCatalog(db,makeCatalog().copyrights),client)(artwork,controller.signal);
  expect(client.autocomplete).not.toHaveBeenCalled();
});

it.each(['correct','wrong','missing','original'] as const)('姓名逆序候选补齐作品元数据，投稿作品为 %s 时的处理', async state => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const dc=new DanbooruCatalog(db,makeCatalog().copyrights);
  const mk=()=>({catalog:new CharacterCatalog(db,{copyrights:dc}),copyrights:dc});
  const tag='family_given';
  const meta=(name:string,category:number)=>({name,category,post_count:30,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]});
  const discover=createPixivDiscovery(db,dc,{
    autocomplete:async query=>query==='Given Family'?[{type:'tag-word',category:4,value:tag}]:[],
    tagsByNames:async tags=>tags.map(t=>meta(t,t===tag?4:3)),
    wikiByTitles:async tags=>tags.map(t=>({title:t,other_names:t==='new_work'?['新作品']:[],is_deleted:false})),
    relatedCopyrights:async()=>({query:tag,post_count:30,tag:{name:tag,category:4,post_count:30},related_tags:[{tag:{name:'new_work',category:3,post_count:300},frequency:1}]}),
  });
  const artwork={...art(4,['Given Family'],'123',state==='missing'?[]:[state==='wrong'?'ゲームB':'新作品']),isOriginal:state==='original'};
  await syncPixivCharacters(ctx,job,mk,{artwork:async()=>artwork},0,discover);
  expect(links()).toHaveLength(state==='correct'?2:0);
  if(state!=='original')expect(dc.copyrights(tag)).toEqual(['new_work']);
  if(state==='wrong') {
    // A contextual rejection must not suppress a later artwork with the right work.
    await discover(art(4,['Given Family'],'456',['新作品']),controller.signal);
    expect(createPixivMatcher(db,mk().catalog,dc)(art(4,['Given Family'],'456',['新作品']))).toEqual({tags:[tag],automatic:true});
  }
});

it('模糊召回仍须验证完整别名，普通标签和限定词冲突不写成角色', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const dc=new DanbooruCatalog(db,makeCatalog().copyrights);
  const tag='some_character_(game_a)';
  const discover=createPixivDiscovery(db,dc,{
    autocomplete:async()=>[{type:'tag',category:4,value:tag}],
    tagsByNames:async()=>[{name:tag,category:4,post_count:1,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]}],
    wikiByTitles:async()=>[{title:tag,other_names:['別人(作品B)'],is_deleted:false}],
  });
  await discover(art(1,['別人(作品A)']),controller.signal);
  expect(dc.get(tag)).toBeNull();
});

it('补作品失败后已验证名称仍保留，但不绕过作品校验自动关联', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const {DanbooruError}=await import('../danbooru/client.ts');
  const dc=new DanbooruCatalog(db,makeCatalog().copyrights),tag='verified_character';
  const discover=createPixivDiscovery(db,dc,{
    autocomplete:async query=>[{type:'tag',category:4,value:tag,antecedent:query}],
    tagsByNames:async()=>[{name:tag,category:4,post_count:1,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]}],
    wikiByTitles:async()=>[],
    relatedCopyrights:async()=>{throw new DanbooruError('offline','network');},
  });
  const mk=()=>({catalog:new CharacterCatalog(db,{copyrights:dc}),copyrights:dc});
  const summary=await syncPixivCharacters(ctx,job,mk,{artwork:async()=>art(1,['確かな原名'])},0,discover);
  expect(summary).toContain('建议 2'); expect(links()).toHaveLength(0);
  expect(db.prepare('SELECT DISTINCT danbooru_tag FROM character_suggestions').pluck().all()).toEqual([tag]);
});

it('已知名字但缺少作品元数据时会补齐，失败后下一轮仍可恢复', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const dc=new DanbooruCatalog(db,makeCatalog().copyrights),tag='known_without_work';
  name(tag,'已知角色');
  const metadata=(name:string,category:number)=>({name,category,post_count:30,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]});
  dc.upsertBase(metadata(tag,4),'now');
  const relatedCopyrights=vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({query:tag,post_count:30,tag:{name:tag,category:4,post_count:30},related_tags:[{tag:{name:'game_a',category:3,post_count:300},frequency:1}]});
  const client={autocomplete:vi.fn(),tagsByNames:async()=>[metadata('game_a',3)],wikiByTitles:async()=>[],relatedCopyrights};
  await expect(createPixivDiscovery(db,dc,client)(art(3,['已知角色']),controller.signal)).rejects.toThrow('timeout');
  await createPixivDiscovery(db,dc,client)(art(3,['已知角色']),controller.signal);
  expect(dc.copyrights(tag)).toEqual(['game_a']);
  expect(createPixivMatcher(db,new CharacterCatalog(db,{copyrights:dc}),dc)(art(3,['已知角色']))).toEqual({tags:[tag],automatic:true});
  expect(client.autocomplete).not.toHaveBeenCalled();
});

it('只有离线词典、没有在线缓存行的角色也能补齐所属作品', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const dc=new DanbooruCatalog(db,makeCatalog().copyrights),tag='dictionary_character';
  name(tag,'词典角色');
  const metadata=(name:string,category:number)=>({name,category,post_count:30,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]});
  const client={autocomplete:vi.fn(),tagsByNames:async(names:string[])=>names.map(n=>metadata(n,n===tag?4:3)),wikiByTitles:async()=>[],
    relatedCopyrights:async()=>({query:tag,post_count:30,tag:{name:tag,category:4,post_count:30},related_tags:[{tag:{name:'game_a',category:3,post_count:300},frequency:1}]})};
  await createPixivDiscovery(db,dc,client)(art(3,['词典角色']),controller.signal);
  expect(dc.copyrights(tag)).toEqual(['game_a']);
  expect(createPixivMatcher(db,new CharacterCatalog(db,{copyrights:dc}),dc)(art(3,['词典角色']))).toEqual({tags:[tag],automatic:true});
  expect(client.autocomplete).not.toHaveBeenCalled();
});

it('补作品没结果时每个角色每轮只问一次；Danbooru 上没有的记下来，下一轮也不再问', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const dc=new DanbooruCatalog(db,makeCatalog().copyrights);
  const metadata=(name:string,category:number)=>({name,category,post_count:30,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]});
  // gone：Danbooru 上查不到；renamed：返回的是改过的名字；dict_only：只有词典，查不到第 4 类
  name('gone_character','消失角色'); name('renamed_character','改名角色'); name('dict_only','词典孤儿');
  dc.upsertBase(metadata('gone_character',4),'now'); dc.upsertBase(metadata('renamed_character',4),'now');
  const relatedCopyrights=vi.fn(async(tag:string)=>({query:tag,post_count:30,
    tag:tag==='gone_character'?null:{name:'new_name',category:4,post_count:30},related_tags:[]}));
  const tagsByNames=vi.fn(async()=>[]);
  const client={autocomplete:vi.fn(),tagsByNames,wikiByTitles:async()=>[],relatedCopyrights};
  const round=async()=>{
    const discover=createPixivDiscovery(db,dc,client);
    for(let i=0;i<3;i++) await discover(art(1,['消失角色','改名角色','词典孤儿'],String(i)),controller.signal);
  };
  await round();
  const calls=()=>relatedCopyrights.mock.calls.map(c=>c[0]).sort();
  expect(calls()).toEqual(['gone_character','renamed_character']);
  expect(tagsByNames).toHaveBeenCalledTimes(1);
  expect(dc.get('gone_character')!.relatedFetchedAt).not.toBeNull();
  expect(dc.get('renamed_character')!.relatedFetchedAt).toBeNull();
  await round();
  // 查不到的不再问；改名和缺第 4 类的下一轮再试一次
  expect(calls()).toEqual(['gone_character','renamed_character','renamed_character']);
  expect(tagsByNames).toHaveBeenCalledTimes(2);
  expect(client.autocomplete).not.toHaveBeenCalled();
});

it('召回多个经别名验证的同名角色时仍保持歧义，不自动关联', async () => {
  const {createPixivDiscovery}=await import('./discovery.ts'); const {DanbooruCatalog}=await import('../danbooru/catalog.ts');
  const dc=new DanbooruCatalog(db,makeCatalog().copyrights),tags=['one_(game_a)','two_(game_a)'];
  const client={autocomplete:async()=>tags.map(value=>({type:'tag',value,category:4})),
    tagsByNames:async()=>tags.map(name=>({name,category:4,post_count:30,is_deprecated:false,antecedent_implications:[],consequent_aliases:[]})),
    wikiByTitles:async()=>tags.map(title=>({title,other_names:['共享名字'],is_deleted:false}))};
  const mk=()=>({catalog:new CharacterCatalog(db,{copyrights:dc}),copyrights:dc});
  await syncPixivCharacters(ctx,job,mk,{artwork:async()=>art(1,['共享名字'])},0,createPixivDiscovery(db,dc,client));
  expect(links()).toHaveLength(0);
  expect(db.prepare('SELECT DISTINCT danbooru_tag FROM character_suggestions ORDER BY danbooru_tag').pluck().all()).toEqual(tags);
});
