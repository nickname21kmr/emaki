import { expect, it } from 'vitest';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { makeTmpDir } from '../../../test/helpers/tmp.ts';
import { cachedArtwork, cacheArtwork } from './cache.ts';

it('投稿缓存跨数据库重开持久化，保留原创、页数和译名', () => {
  const dir=makeTmpDir('pixiv-cache'), file=path.join(dir,'cache.sqlite');
  let db=openDatabase(file);
  const artwork={id:'123',pageCount:5,isOriginal:true,tags:{tags:[{tag:'オリジナル',translation:{en:'original'}}]}};
  try {
    migrate(db); cacheArtwork(db,artwork,'2026-10-22T00:00:00Z'); db.close(); db=openDatabase(file);
    expect(cachedArtwork(db,'123')).toEqual(artwork);
    expect(cachedArtwork(db,'456')).toBeUndefined();
    // 结构不完整、ID 不一致的旧缓存不当成有效结果。
    db.prepare("UPDATE pixiv_artwork_cache SET artwork='{}' WHERE post_id='123'").run();
    expect(cachedArtwork(db,'123')).toBeUndefined();
    db.prepare('UPDATE pixiv_artwork_cache SET artwork=?').run(JSON.stringify({...artwork,id:'456'}));
    expect(cachedArtwork(db,'123')).toBeUndefined();
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});
