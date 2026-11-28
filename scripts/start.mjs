// 一键启动（T23）：检查 Node → 在后端的端口上起「启动页」并打开窗口 → 按需安装依赖 → 按需构建前端 → 启动后端（同时托管前端）
// → 后端准备好监听时启动页把端口让给它，窗口里的启动页自己换成应用。
// 已在运行时只打开浏览器；另一个 Emaki 正在启动时直接退出。只用 Node 内置模块，不需要 tsx。
// 用法：node scripts/start.mjs [--rebuild] [--demo] [--no-open] [--app]；Windows 上双击仓库根目录的 start.bat。
// --app：用 Edge / Chrome 的应用窗口打开（像桌面程序，没有地址栏），关掉这个窗口后端也跟着退出。桌面快捷方式用的就是它。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSplashServer, probe } from './splash-server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const log = (msg) => console.log(`[Emaki] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// 后端监听的地址（apps/server/src/config.ts 的 host）：启动页占的必须是同一个，交接才接得上
const host = process.env.EMAKI_HOST ?? '127.0.0.1';
const url = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${port}`;
const dataDir = path.resolve(root, process.env.EMAKI_DATA_DIR ?? 'data');

/** 正在跑的 npm（安装依赖 / 构建前端）；窗口提前关掉时要一起结束 */
let npmChild = null;
/** 后端进程 */
let server = null;
/** 后端已经在听 ipc 消息了（它一进入口就会说一声） */
let backendListens = false;
/** 后端回过健康检查了 */
let ready = false;
/** 谁要求退出的：window = 应用窗口关了，signal = Ctrl+C / 关黑色窗口 */
let stopping = null;

/** npm 在 Windows 上是 npm.cmd，spawn 必须 shell: true */
function run(cmd, cmdArgs, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: true, env });
    npmChild = child;
    child.on('exit', (code) => {
      npmChild = null;
      // 窗口关了、是我们结束它的：后面的步骤不做了，等着退出
      if (!stopping) resolve(code ?? 1);
    });
  });
}

/** Windows 上连整棵进程树一起结束：npm 是经 cmd 起的；AI 助手拉起的 agent 和它跑的命令是后端的子进程，只结束后端会留下孤儿进程 */
function killTree(child, sig) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', timeout: 5000 });
  } else child.kill(sig);
}

/** 应用窗口用的浏览器：EMAKI_APP_BROWSER 指定的优先；否则 Edge（Windows 自带），其次 Chrome */
function findAppBrowser() {
  if (process.env.EMAKI_APP_BROWSER) {
    const custom = path.resolve(root, process.env.EMAKI_APP_BROWSER);
    if (existsSync(custom)) return custom;
    log(`EMAKI_APP_BROWSER 指的文件不存在：${custom}，改成自动查找。`);
  }
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
 * 应用窗口的浏览器配置目录：窗口位置、存在浏览器里的界面偏好（底色、模糊设置）都在里面，跟着数据目录走。
 * 以前固定在 <仓库>/data/app-window：库已经搬到别处（EMAKI_DATA_DIR）的老用户接着用那一份，不然这些偏好会重置一次。
 */
function appProfileDir() {
  const dir = path.join(dataDir, 'app-window');
  const legacy = path.join(root, 'data', 'app-window');
  return !existsSync(dir) && existsSync(legacy) && existsSync(path.join(dataDir, 'emaki.sqlite')) ? legacy : dir;
}

/**
 * 应用窗口：单独的浏览器配置目录，这样启动的就是一个独立的浏览器进程，
 * 窗口关掉进程就结束，返回的 promise 随之完成。找不到 Edge / Chrome 时返回 null，调用方改用普通浏览器。
 */
function openAppWindow() {
  const browser = findAppBrowser();
  if (!browser) return null;
  const profile = appProfileDir();
  // 初始大小只在第一次给：每次都传的话浏览器会拿它盖掉上次的大小，最大化的窗口也会变回普通窗口。
  // 标记带版本号：以后换了 --app 的地址（浏览器按地址记窗口位置），把版本加一就能重新给一次初始大小
  const sized = path.join(profile, '.emaki-window-v1');
  const first = !existsSync(sized);
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      ...(first ? ['--window-size=1440,920'] : []),
    ],
    { stdio: 'ignore' },
  );
  // 进程起来了（有 pid）就记下，不等事件：「已在运行」那条路开完窗口马上就退出了
  if (first && child.pid) {
    try {
      mkdirSync(profile, { recursive: true });
      writeFileSync(sized, '');
    } catch {}
  }
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

// ---------------------------------------------------------------- 已在运行 / 正在启动 / 端口被占用
/** 端口上已经有人时在这里收场，能接着启动才返回 */
function leaveIfTaken(who) {
  if (who.kind === 'running') {
    log(`Emaki 已经在运行：${url}`);
    openBrowser();
    process.exit(0);
  }
  if (who.kind === 'starting') {
    // 那边的窗口已经开了；这里再起一份，就是第二个后端去开同一个库
    log(who.stage === 'failed' ? '上一次启动没有成功，它的窗口还开着：关掉那个窗口再试。' : '另一个 Emaki 正在启动，它的窗口马上就好。');
    process.exit(0);
  }
  if (who.kind === 'occupied') {
    log(`端口 ${port} 被别的程序占用了。可以在仓库根目录的 .env 里写一行 EMAKI_PORT=5184 换一个端口。`);
    process.exit(1);
  }
}
leaveIfTaken(await probe(url));

// ---------------------------------------------------------------- 启动页
// 先占住后端的端口、把窗口打开，再做下面的慢步骤：双击后马上有东西看，浏览器的启动也和后端的启动同时进行
const state = { stage: 'checking', error: null };
/** 启动失败的退出码（start.bat 遇到非 0 会停下来，黑色窗口里的报错还能看） */
let failCode = 0;
/** 页面读到了失败原因 */
let onFailureRead = () => {};
let page;
try {
  page = readFileSync(path.join(import.meta.dirname, 'splash.html'));
} catch {
  // 启动页文件不在（包没打全）也要能启动：退到一行字
  page =
    '<!doctype html><meta charset="utf-8"><title>Emaki 絵巻</title><p>正在打开 Emaki…</p>' +
    '<script>setInterval(() => fetch("/api/health").then((r) => r.ok && location.reload(), () => {}), 300)</script>';
}
const splash = createSplashServer({ page, state: () => state, onReported: (stage) => stage === 'failed' && onFailureRead() });
let onListenError = null;
splash.on('error', (err) => onListenError?.(err));
/** 占上端口返回 null，占不上返回错误 */
function listenSplash() {
  return new Promise((resolve) => {
    onListenError = resolve;
    splash.listen(port, host, () => {
      onListenError = null;
      resolve(null);
    });
  });
}
function closeSplash() {
  return new Promise((resolve) => {
    if (!splash.listening) return resolve();
    splash.close(() => resolve());
    splash.closeAllConnections();
  });
}

const taken = await listenSplash();
if (taken) {
  // 探完到占上端口之间被抢先了（两次双击挨得很近）
  leaveIfTaken(await probe(url));
  log(
    taken.code === 'EADDRINUSE'
      ? `端口 ${port} 被别的程序占用了。可以在仓库根目录的 .env 里写一行 EMAKI_PORT=5184 换一个端口。`
      : `没能监听 ${host}:${port}：${taken.message}`,
  );
  process.exit(1);
}

const closed = openBrowser();
// 应用窗口关了就退出，不管启动到了哪一步（识别等任务下次启动会接着做）
void closed?.then(async () => {
  log('Emaki 窗口已关闭，正在退出…');
  stopping = 'window';
  // 马上再打开的那一次不该看到这边的启动页，以为还在启动
  void closeSplash();
  killTree(npmChild);
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    if (backendListens && server.connected) {
      // 请后端自己收尾（待移进回收站的文件、识别子进程、数据库）；5 秒还没退出再连进程树一起结束
      server.send({ type: 'emaki:shutdown' }, () => {});
      const force = setTimeout(() => killTree(server), 5000);
      await exited;
      clearTimeout(force);
    } else {
      // 后端还在加载代码，没有要收尾的东西
      killTree(server);
      await exited;
    }
  }
  process.exit(failCode);
});

/**
 * 没能启动：原因交给启动页，窗口里看得到。应用窗口留着启动页，等窗口关掉再带着退出码结束；
 * 默认浏览器看不到页面什么时候关，等它读到原因就结束。
 */
async function fail(reason, code) {
  failCode = code || 1;
  state.stage = 'failed';
  state.error = reason;
  if (args.has('--no-open')) process.exit(failCode);
  // 后端是在交接之后才出的错：端口已经让出去了，重新占上页面才读得到原因
  if (!splash.listening && (await listenSplash())) process.exit(failCode);
  if (!closed) {
    // 浏览器可能还没起来，最多等 15 秒
    await Promise.race([new Promise((resolve) => (onFailureRead = resolve)), sleep(15_000)]);
    process.exit(failCode);
  }
  return new Promise(() => {});
}

// 免安装版（scripts/pack-portable.mjs 打的包）：依赖和前端都已经装好、构建好，也没有 npm
const portable = existsSync(path.join(root, 'portable.json'));

// ---------------------------------------------------------------- 依赖
const lockHash = createHash('sha256').update(readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
const hashFile = path.join(root, 'node_modules/.emaki-install-hash');
if (!portable && (!existsSync(hashFile) || readFileSync(hashFile, 'utf8').trim() !== lockHash)) {
  state.stage = 'installing';
  log('正在安装依赖（第一次会比较久）…');
  const code = await run('npm', ['install']);
  if (code !== 0) {
    log('依赖安装失败。国内网络可以先运行：npm config set registry https://registry.npmmirror.com');
    await fail('依赖安装失败', code);
  }
  writeFileSync(hashFile, lockHash);
  state.stage = 'checking';
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
  state.stage = 'building';
  log('正在构建前端…');
  const code = await run('npm', ['run', 'build']);
  if (code !== 0) {
    log('前端构建失败，上面是错误信息。');
    await fail('界面构建失败', code);
  }
}

// ---------------------------------------------------------------- 启动后端
// 直接用当前的 node 加 tsx loader 启动，不走 npm：
// - 免安装版里没有 npm；
// - loader 要出现在 execArgv 里，识别子进程（services/tagger/client.ts）才能继承它跑 .ts
// ipc 通道和 EMAKI_LAUNCHER：后端靠它们请启动页让出端口、听「窗口关了」的通知（apps/server/src/system/launcher.ts）
state.stage = 'opening';
server = spawn(process.execPath, ['--import', 'tsx', path.join('apps', 'server', 'src', 'index.ts')], {
  cwd: root,
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  env: {
    ...process.env,
    EMAKI_DATA_SOURCE: args.has('--demo') || args.has('--mock') ? 'demo' : (process.env.EMAKI_DATA_SOURCE ?? 'sqlite'),
    // sharp 和文件读写共用 libuv 线程池（见 T04）
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '8',
    EMAKI_LAUNCHER: '1',
  },
});
const slow = setTimeout(() => log('后端 60 秒内没有就绪，请查看上面的日志。'), 60_000);
server.on('message', async (msg) => {
  if (msg?.type === 'emaki:hello') backendListens = true;
  if (msg?.type !== 'emaki:before-listen') return;
  // 后端要监听了：把端口让出来。窗口里的启动页这一瞬连不上，它会接着试
  await closeSplash();
  server.send({ type: 'emaki:port-free' }, () => {});
  // 就绪只用来打日志（窗口早就开了，页面自己会换成应用）：每 100ms 探测一次
  const alive = () => server.exitCode === null && server.signalCode === null;
  while (alive() && !stopping && !(await healthy())) await sleep(100);
  if (!alive() || stopping) return;
  ready = true;
  clearTimeout(slow);
  log(closed ? `Emaki 已启动：${url}（关掉 Emaki 窗口即退出）` : `Emaki 已启动：${url}（关闭这个窗口即退出）`);
});
server.on('exit', (code) => {
  clearTimeout(slow);
  // 应用窗口关掉后是我们请它退出的：上面等着它，正常结束
  if (stopping === 'window') return;
  // 用着用着后端退出了，或者是 Ctrl+C：跟着退出（start.bat 遇到非 0 会停下来等按键）
  if (ready || stopping) process.exit(code ?? 1);
  log(`后端没能启动（退出码 ${code ?? '无'}），上面是错误信息。`);
  void fail(`后端启动时出错了（退出码 ${code ?? '无'}）`, code ?? 1);
});
// SIGHUP：直接关掉这个黑色窗口
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping ??= 'signal';
    // 后端已经没了（启动失败，停在 fail() 等窗口关掉）：没有要等的，直接退出
    if (server.exitCode !== null || server.signalCode !== null) process.exit(failCode || 130);
    killTree(server, sig);
  });
}
