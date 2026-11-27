import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

// 仓库根目录的 .env（可选）；已经存在的环境变量优先，不会被覆盖
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

/** sqlite：真实图库；demo：演示数据（真实引擎 + 演示数据 + 假部件，见 demo/engine.ts） */
export type DataSourceKind = 'demo' | 'sqlite';
export type ModelSourceId = 'huggingface' | 'hf-mirror' | 'modelscope';

// 相对路径一律按仓库根目录解析：npm -w 运行时 cwd 是 apps/server，按 cwd 解析会落到 apps/server/data
const dataDir = path.resolve(repoRoot, process.env.EMAKI_DATA_DIR ?? 'data');

/** 命令行 --demo（旧写法 --mock 也认）> 环境变量 EMAKI_DATA_SOURCE（demo，旧写法 mock 也认）> 默认 sqlite */
const demo =
  process.argv.includes('--mock') || process.argv.includes('--demo') || ['demo', 'mock'].includes(process.env.EMAKI_DATA_SOURCE ?? '');

/**
 * 所有配置都来自环境变量（或仓库根目录的 .env），`npm run dev:demo` 切到演示数据。
 * 见 docs/ARCHITECTURE.md「配置」一节。
 */
export const config = {
  repoRoot,
  host: process.env.EMAKI_HOST ?? '127.0.0.1',
  /**
   * 额外允许的 Host（逗号分隔），只影响 app.ts 的 Host 校验，不改变监听地址。不填就只认本机。
   * 以前手机访问要把 EMAKI_HOST 改成局域网地址、这里填局域网 IP，那样没有任何身份验证，局域网里谁都能改图库；
   * 有了局域网入口（设置 →「手机访问」，https + 设备凭证，docs/mobile.md 第 2 节）以后不推荐这样用。
   */
  allowedHosts: (process.env.EMAKI_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  port: Number(process.env.EMAKI_PORT ?? 5174),
  /**
   * sqlite：真实图库，读写 dataDir 下的数据库和缩略图缓存（默认）。
   * demo：演示数据，跑的也是真实引擎，只是换成演示数据和假部件，绝不碰用户的图库文件夹。
   * 优先级：命令行 --demo / --mock > 环境变量（demo，旧写法 mock）> 默认 sqlite。
   */
  dataSource: (demo ? 'demo' : 'sqlite') as DataSourceKind,
  /**
   * 安全模式（docs/plugins.md 第 8 节）：只用内置插件、全部按原样，我的和装的插件不加载，覆盖不生效。
   * 命令行 --safe 或环境变量 EMAKI_SAFE=1；网页上地址加 ?safe 是同一件事的网页这一半
   */
  safeMode: process.argv.includes('--safe') || process.env.EMAKI_SAFE === '1',
  /** 数据库、缩略图缓存、模型文件、AI 助手的设置都放这里；已被 .gitignore 忽略 */
  dataDir,
  /** 图库数据库所在的目录：演示模式是 <dataDir>/demo（每次启动清空重建），否则就是 dataDir */
  libraryDir: demo ? path.join(dataDir, 'demo') : dataDir,
  /** 生产模式下由后端直接托管前端构建产物 */
  webDist: path.join(repoRoot, 'apps/web/dist'),
  /** 随 Emaki 一起发的插件（docs/plugins.md 第 6 节）：默认没装，在「插件」页「附带的」里启用 */
  bundledPluginsDir: path.join(repoRoot, 'plugins'),
  /** 随仓库分发的数据文件（离线对照表、词库） */
  assetsDir: path.join(repoRoot, 'apps/server/assets'),
  /** 用户自己放的 PoseWear 线稿（按姿势找图的封面）：免安装包的根目录、开发时仓库根目录下的 pose-covers/ */
  poseCoversDir: process.env.EMAKI_POSE_COVERS_DIR ? path.resolve(repoRoot, process.env.EMAKI_POSE_COVERS_DIR) : path.join(repoRoot, 'pose-covers'),
  /** 模型文件目录；多个开发库可共用一份 */
  modelsDir: process.env.EMAKI_MODELS_DIR ? path.resolve(repoRoot, process.env.EMAKI_MODELS_DIR) : path.join(dataDir, 'models'),
  /** 模型下载源（逗号分隔），会并行测速，选最快的 */
  modelSources: (process.env.EMAKI_MODEL_SOURCES ?? 'huggingface,hf-mirror,modelscope')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ModelSourceId[],
  /** 兼容 huggingface_hub 的 HF_ENDPOINT 约定（例如 https://hf-mirror.com） */
  hfEndpoint: (process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, ''),
  /** 强制 DirectML 适配器序号；不设就自动探测，结果缓存到 <modelsDir>/dml-device.json */
  dmlDeviceId: process.env.EMAKI_DML_DEVICE_ID ? Number(process.env.EMAKI_DML_DEVICE_ID) : null,
  /** 出网代理；不设时自动读 Windows 系统代理（见 net/proxy.ts） */
  httpProxy: process.env.EMAKI_HTTP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null,
  /** 开发时可指向 https://testbooru.donmai.us；离线测试可指向 http://127.0.0.1:9 */
  danbooruBaseUrl: process.env.EMAKI_DANBOORU_URL ?? 'https://danbooru.donmai.us',
  appVersion: (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version,
  /** User-Agent 里的项目地址；上传 GitHub 后填真实地址 */
  appRepoUrl: 'https://github.com/nickname21kmr/emaki',
} as const;
