// 一键启动（T23）：检查 Node → 按需安装依赖 → 按需构建前端 → 启动后端（同时托管前端）→ 就绪后打开浏览器。
// 已在运行时只打开浏览器。只用 Node 内置模块，不需要 tsx。
// 用法：node scripts/start.mjs [--rebuild] [--mock] [--no-open] [--app]；Windows 上双击仓库根目录的 start.bat。
// --app：用 Edge / Chrome 的应用窗口打开（像桌面程序，没有地址栏），关掉这个窗口后端也跟着退出。桌面快捷方式用的就是它。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const log = (msg) => console.log(`[Emaki] ${msg}`);

// ---------------------------------------------------------------- Node 版本
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  log(`需要 Node.js 22 或更新的版本（推荐 24 LTS），当前是 ${process.versions.node}。请到 https://nodejs.org/ 安装后再运行。`);
  process.exit(1);
}

// 和后端一样读仓库根目录的 .env（已有的环境变量优先）
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {}
const port = Number(process.env.EMAKI_PORT ?? 5174);
const url = `http://127.0.0.1:${port}`;

/** npm 在 Windows 上是 npm.cmd，spawn 必须 shell: true */
function run(cmd, cmdArgs, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: true, env });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** 应用窗口用的浏览器：Edge 优先（Windows 自带），其次 Chrome */
function findAppBrowser() {
  if (process.platform !== 'win32') return null;
  const dirs = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const rel of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
    for (const d of dirs) {
      const p = path.join(d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 应用窗口：单独的浏览器配置目录（data/app-window），这样启动的就是一个独立的浏览器进程，
 * 窗口关掉进程就结束，返回的 promise 随之完成。找不到 Edge / Chrome 时返回 null，调用方改用普通浏览器。
 */
function openAppWindow() {
  const browser = findAppBrowser();
  if (!browser) return null;
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${path.join(root, 'data', 'app-window')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--window-size=1440,920',
    ],
    { stdio: 'ignore' },
  );
  return new Promise((resolve) => {
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

function openBrowser() {
  if (args.has('--no-open')) return;
  if (args.has('--app')) {
    const closed = openAppWindow();
    if (closed) return closed;
  }
  // 不用 `start "" url`：网址里有 & 时会被 cmd 截断。explorer 的退出码是 1，忽略
  const [cmd, a] =
    process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, a, { detached: true, stdio: 'ignore' }).unref();
}

async function healthy() {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 已在运行
if (await healthy()) {
  log(`Emaki 已经在运行：${url}`);
  openBrowser();
  process.exit(0);
}

// 免安装版（scripts/pack-portable.mjs 打的包）：依赖和前端都已经装好、构建好，也没有 npm
const portable = existsSync(path.join(root, 'portable.json'));

// ---------------------------------------------------------------- 依赖
const lockHash = createHash('sha256').update(readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
const hashFile = path.join(root, 'node_modules/.emaki-install-hash');
if (!portable && (!existsSync(hashFile) || readFileSync(hashFile, 'utf8').trim() !== lockHash)) {
  log('正在安装依赖（第一次会比较久）…');
  const code = await run('npm', ['install']);
  if (code !== 0) {
    log('依赖安装失败。国内网络可以先运行：npm config set registry https://registry.npmmirror.com');
    process.exit(code);
  }
  writeFileSync(hashFile, lockHash);
}

// ---------------------------------------------------------------- 前端构建
/** 目录（或文件）里最新的修改时间 */
function newest(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    max = Math.max(max, newest(path.join(p, e.name)));
  }
  return max;
}
const built = path.join(root, 'apps/web/dist/index.html');
const sources = ['apps/web/src', 'apps/web/index.html', 'apps/web/vite.config.ts', 'apps/web/public', 'packages/shared/src'];
const srcTime = Math.max(...sources.map((p) => newest(path.join(root, p))));
if (!portable && (args.has('--rebuild') || !existsSync(built) || statSync(built).mtimeMs < srcTime)) {
  log('正在构建前端…');
  const code = await run('npm', ['run', 'build']);
  if (code !== 0) {
    log('前端构建失败，上面是错误信息。');
    process.exit(code);
  }
}

// ---------------------------------------------------------------- 端口被别的程序占用
const occupied = await fetch(url, { signal: AbortSignal.timeout(800) }).then(
  () => true,
  (e) => e?.cause?.code !== 'ECONNREFUSED',
);
if (occupied) {
  log(`端口 ${port} 被别的程序占用了。可以在仓库根目录的 .env 里写一行 EMAKI_PORT=5184 换一个端口。`);
  process.exit(1);
}

// ---------------------------------------------------------------- 启动后端
// 直接用当前的 node 加 tsx loader 启动，不走 npm：
// - 免安装版里没有 npm；
// - loader 要出现在 execArgv 里，识别子进程（services/tagger/client.ts）才能继承它跑 .ts
const server = spawn(process.execPath, ['--import', 'tsx', path.join('apps', 'server', 'src', 'index.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    EMAKI_DATA_SOURCE: args.has('--mock') ? 'mock' : (process.env.EMAKI_DATA_SOURCE ?? 'sqlite'),
    // sharp 和文件读写共用 libuv 线程池（见 T04）
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '8',
  },
});
// 应用窗口关掉后是我们主动结束的后端：正常退出（start.bat 遇到非 0 会停下来等按键）
let closing = false;
server.on('exit', (code) => process.exit(closing ? 0 : (code ?? 1)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));

// 每 300ms 探测一次，最长 60 秒
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if (await healthy()) {
    const closed = openBrowser();
    if (closed) {
      log(`Emaki 已启动：${url}（关掉 Emaki 窗口即退出）`);
      // 应用窗口关了：后端一起退出（识别等任务下次启动会接着做）
      void closed.then(() => {
        log('Emaki 窗口已关闭，正在退出…');
        closing = true;
        server.kill();
      });
    } else {
      log(`Emaki 已启动：${url}（关闭这个窗口即退出）`);
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 300));
}
if (Date.now() >= deadline) log('后端 60 秒内没有就绪，请查看上面的日志。');
