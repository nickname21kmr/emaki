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
// 快照所在目录助手可以免审批读取：去掉 settings 里的凭证（secret.*），secure_delete 把原记录清零
const snap = new Database(dst);
if (snap.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='settings'").get()) {
  snap.pragma('secure_delete = ON');
  snap.prepare("DELETE FROM settings WHERE key LIKE 'secret.%'").run();
}
snap.close();
console.log(`快照：${dst}`);
