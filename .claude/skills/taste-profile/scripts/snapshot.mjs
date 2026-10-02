// 给图库数据库做一份只读快照（VACUUM INTO），之后所有统计都读快照，不碰正在用的库
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { args, Database } from './lib.mjs';

const { dataDir, out } = args();
const src = path.join(dataDir, 'emaki.sqlite');
if (!existsSync(src)) throw new Error(`找不到图库数据库：${src}（用 --data 指定 Emaki 的数据目录）`);
const dst = path.join(out, 'lib.sqlite');
rmSync(dst, { force: true });
const db = new Database(src, { readonly: true });
db.exec(`VACUUM INTO '${dst.replace(/\\/g, '/').replace(/'/g, "''")}'`);
db.close();
console.log(`快照：${dst}`);
