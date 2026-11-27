// 开发时跑后端（npm run dev）：代码改了就重启后端，代替 node --watch。只用 Node 自带的模块，不需要 tsx。
//
// 为什么不用 node --watch：Windows 开着「上次访问时间」（fsutil behavior query disablelastaccess 是 0 或 2）时，读一个文件也会发
// 「改了」的通知；node --watch 只认通知，于是按需加载模块的那一刻——第一次联网（undici 这时才读 llhttp_simd-wasm.js）、第一次接 MCP——
// 后端被自己重启，跑着的任务全丢（2026-11-26：平板上点「下载这个作品」，下载任务刚开始后端就重启了）。
// 这里收到通知以后再看文件的修改时间和大小，真的变了才重启。
//
// 看 apps/server/src 和 packages/shared/src 下的源码（node_modules 变了要自己重启，装了新依赖时本来就要）。同样的道理，
// 扫描图库时比对大小和修改时间、只改属性不算改动的，见 services/watch/LibraryWatcher.ts（docs/TASKS.md T25）。
// 后端自己退出（崩了）时不自动拉起，等代码改了再启动，和 node --watch 一样。参数原样传给后端。
import { spawn } from 'node:child_process';
import { readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';

const server = path.resolve(import.meta.dirname, '..');
const ROOTS = [path.join(server, 'src'), path.resolve(server, '../../packages/shared/src')];
// .sql 不看（docs/TASKS.md MS-8：改迁移文件不立刻重启、不立刻跑到库上，和 node --watch 时一样）
const SOURCE = /\.(?:[cm]?[jt]sx?|json)$/;
const log = (msg) => console.log(`[dev] ${msg}`);

/** 文件现在的样子：修改时间 + 大小（读文件只改访问时间，不改这两个）；不在了是 null */
function fingerprint(file) {
  try {
    const s = statSync(file);
    return s.isFile() ? `${s.mtimeMs}:${s.size}` : null;
  } catch {
    return null;
  }
}

const known = new Map();
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (SOURCE.test(e.name)) known.set(p, fingerprint(p));
  }
}
for (const root of ROOTS) walk(root);

let child = null;
let timer = null;
let changed = [];

function start() {
  // 多一条 IPC 通道：重启时让后端自己正常退出（Windows 上没有信号，kill 就是强杀：数据库没关好、改内部的插件的启动记录没擦，
  // 下次启动会当成崩了，见 services/plugins/internal.ts）
  const me = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...process.argv.slice(2)], {
    cwd: server,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  child = me;
  me.on('exit', (code, signal) => {
    if (child !== me) return; // 重启时是这里关掉的
    child = null;
    log(code === 0 ? '后端退出了' : `后端退出了（${signal ?? code}），改了代码以后再启动`);
  });
}

function stopChild() {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => c.kill('SIGKILL'), 5_000);
    c.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    // 通道断了（后端正在退出）就照旧发信号；5 秒还没退就强杀
    if (c.connected) c.send({ type: 'emaki:shutdown' }, (err) => err && c.kill('SIGTERM'));
    else c.kill('SIGTERM');
  });
}

async function restart() {
  const files = [...new Set(changed)];
  changed = [];
  log(`${files.slice(0, 3).join('、')}${files.length > 3 ? ` 等 ${files.length} 个文件` : ''} 改了，重启后端`);
  await stopChild();
  start();
}

for (const root of ROOTS) {
  watch(root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const file = path.join(root, String(name));
    if (!SOURCE.test(file)) return;
    const now = fingerprint(file);
    if (now === (known.get(file) ?? null)) return; // 只是读了一下（访问时间变了）、或者没变
    if (now === null) known.delete(file);
    else known.set(file, now);
    changed.push(path.relative(server, file));
    clearTimeout(timer);
    // git 换版本时一次改很多文件：攒一下，只重启一次
    timer = setTimeout(() => void restart(), 300);
  });
}

for (const sig of process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    clearTimeout(timer);
    void stopChild().then(() => process.exit(0));
  });
}

start();
