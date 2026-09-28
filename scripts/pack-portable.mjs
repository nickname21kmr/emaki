// 打免安装版（Windows x64）：自带 Node.js、后端运行时依赖和构建好的前端，解压后双击「启动 Emaki.cmd」就能用。
// 用法：node scripts/pack-portable.mjs [--out <目录>] [--skip-install]
//
// 步骤：git archive 取出 HEAD（只打已提交的代码）→ npm ci → 构建前端 → 删掉开发依赖和只有前端用的包
//      → 只留 Windows x64 的原生二进制 → 复制当前的 node.exe 到 runtime/ → 写 portable.json 和启动脚本 → 压成 zip。
// 必须在 Windows x64 上跑：better-sqlite3、sharp、onnxruntime-node 都是平台相关的预编译包。
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const argOut = process.argv.indexOf('--out');
const outDir = path.resolve(argOut > 0 ? process.argv[argOut + 1] : path.join(root, 'release'));
const skipInstall = process.argv.includes('--skip-install'); // 调试用：复用上一次的暂存目录
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `Emaki-${pkg.version}-win-x64`;
const stage = path.join(outDir, name);
const zip = path.join(outDir, `${name}.zip`);
const log = (m) => console.log(`[pack] ${m}`);
// 用 Windows 自带的 bsdtar 解包：Git Bash 的 GNU tar 会把「F:」当成远程主机
const TAR = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('只能在 Windows x64 上打包（原生依赖是平台相关的）');
  process.exit(1);
}

function sh(cmd, args) {
  log(`${cmd} ${args.join(' ')}`);
  // npm 在 Windows 上是 npm.cmd，要走 shell
  const r = spawnSync(cmd, args, { cwd: stage, stdio: 'inherit', shell: true, env: { ...process.env, npm_config_update_notifier: 'false' } });
  if (r.status !== 0) {
    console.error(`失败：${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

if (!skipInstall) {
  // 1. 取出已提交的代码（不含 data/、node_modules、未提交的改动）
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const tar = path.join(outDir, `${name}.src.tar`);
  execFileSync('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: root });
  execFileSync(TAR, ['-xf', tar, '-C', stage]);
  rmSync(tar);
  log(`已取出 HEAD（${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim()}）`);

  // 2. 安装依赖、构建前端、删掉开发依赖
  sh('npm', ['ci', '--no-audit', '--no-fund']);
  sh('npm', ['run', 'build']);
  sh('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund']);
}
rmSync(zip, { force: true });

// 3. 便携包里用不到的文件
for (const p of ['.github', '.claude', 'docs', 'apps/web/src', 'apps/web/public', 'apps/server/test', 'vitest.config.ts', '.editorconfig', '.prettierrc']) {
  rmSync(path.join(stage, p), { recursive: true, force: true });
}

// 3b. 只留后端运行时真正用到的包：前端已经构建成静态文件，react、lucide 这些运行时用不到
const nm = path.join(stage, 'node_modules');
/** node_modules 下的路径 → 顶层包名（作用域包取两段）；嵌套的 node_modules 跟着父包走 */
const topName = (p) => {
  const parts = path.relative(nm, p).split(path.sep);
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
};
const serverDeps = new Set(
  execFileSync('npm', ['ls', '-w', '@emaki/server', '--omit=dev', '--all', '--parseable'], { cwd: stage, shell: true })
    .toString()
    .split(/\r?\n/)
    .filter((p) => p.startsWith(nm))
    .map(topName),
);
const topLevel = readdirSync(nm, { withFileTypes: true }).flatMap((e) =>
  e.name.startsWith('.') ? [] : e.name.startsWith('@') ? readdirSync(path.join(nm, e.name)).map((n) => `${e.name}/${n}`) : [e.name],
);
let removed = 0;
for (const pkgName of topLevel) {
  // workspace 链接（@emaki/*）保留
  if (pkgName.startsWith('@emaki/') || serverDeps.has(pkgName)) continue;
  rmSync(path.join(nm, pkgName), { recursive: true, force: true });
  removed++;
}
log(`后端运行时用到 ${serverDeps.size} 个包，删掉了 ${removed} 个只有前端 / 开发才用的包`);

// 3c. 原生包只留 Windows x64 的二进制
const onnxBin = path.join(nm, 'onnxruntime-node', 'bin', 'napi-v6');
for (const plat of existsSync(onnxBin) ? readdirSync(onnxBin) : []) {
  if (plat !== 'win32') rmSync(path.join(onnxBin, plat), { recursive: true, force: true });
  else for (const arch of readdirSync(path.join(onnxBin, plat))) if (arch !== 'x64') rmSync(path.join(onnxBin, plat, arch), { recursive: true, force: true });
}
const sqlitePre = path.join(nm, 'better-sqlite3', 'prebuilds');
for (const f of existsSync(sqlitePre) ? readdirSync(sqlitePre) : []) if (f !== 'win32-x64.node') rmSync(path.join(sqlitePre, f), { force: true });
for (const p of ['deps', 'src']) rmSync(path.join(nm, 'better-sqlite3', p), { recursive: true, force: true });

// 4. 自带 Node.js（就用打包机上这个，版本和测试时一致）
mkdirSync(path.join(stage, 'runtime'), { recursive: true });
copyFileSync(process.execPath, path.join(stage, 'runtime', 'node.exe'));
const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
if (existsSync(nodeLicense)) cpSync(nodeLicense, path.join(stage, 'runtime', 'LICENSE-node.txt'));

// 5. 标记文件：scripts/start.mjs 看到它就跳过 npm install 和前端构建
writeFileSync(
  path.join(stage, 'portable.json'),
  JSON.stringify({ version: pkg.version, node: process.versions.node, builtAt: new Date().toISOString() }, null, 2),
);

// 6. 给小白的入口：中文名的启动脚本 + 一页说明
writeFileSync(path.join(stage, '启动 Emaki.cmd'), ['@echo off', 'cd /d "%~dp0"', 'call start.bat %*', ''].join('\r\n'));
writeFileSync(
  path.join(stage, '使用说明.txt'),
  [
    'Emaki 絵巻 免安装版',
    '',
    '1. 双击「启动 Emaki.cmd」，会自动打开浏览器（http://127.0.0.1:5174）。',
    '2. 第一次打开会让你选图片文件夹。Emaki 只读取图片，不会移动、改名或删除它们。',
    '3. 第一次识别角色时会自动下载约 2 GB 的模型。',
    '4. 用完关掉那个黑色窗口就退出了。',
    '',
    '你的整理记录、缩略图、模型都在这个文件夹的 data 目录里。',
    '升级到新版本时，把旧版的 data 文件夹整个复制到新版里就行，不要删。',
    '',
    '显卡：有独立显卡会快很多（需要较新的显卡驱动）；没有独显会自动用 CPU，能用但慢。',
    '笔记本识别时如果用的是核显、独显闲着，双击 tools 文件夹里的「显卡诊断和修复.cmd」。',
    '更多说明：https://github.com/nickname21kmr/emaki',
    '',
  ].join('\r\n'),
);

// 7. 压缩：用 .NET 的 ZipFile（UTF-8 文件名；Windows 自带 tar 写大 zip 会崩溃）
log('正在压缩…');
const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${stage.replace(/'/g, "''")}', '${zip.replace(/'/g, "''")}', [IO.Compression.CompressionLevel]::Optimal, $true)`;
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit' });
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(0);
log(`完成：${zip}（${mb(zip)} MB）`);
