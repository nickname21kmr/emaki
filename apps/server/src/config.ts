import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

// 仓库根目录的 .env（可选）；已经存在的环境变量优先，不会被覆盖
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

export type DataSourceKind = 'mock' | 'sqlite';
export type ModelSourceId = 'huggingface' | 'hf-mirror' | 'modelscope';

// 相对路径一律按仓库根目录解析：npm -w 运行时 cwd 是 apps/server，按 cwd 解析会落到 apps/server/data
const dataDir = path.resolve(repoRoot, process.env.EMAKI_DATA_DIR ?? 'data');

/**
 * 所有配置都来自环境变量（或仓库根目录的 .env），`npm run dev:mock` 切到演示数据。
 * 见 docs/ARCHITECTURE.md「配置」一节。
 */
export const config = {
  repoRoot,
  host: process.env.EMAKI_HOST ?? '127.0.0.1',
  port: Number(process.env.EMAKI_PORT ?? 5174),
  /**
   * sqlite：真实实现，读写 dataDir 下的数据库和缩略图缓存（默认）。
   * mock：内存假数据 + SVG 占位图，前端开发用。优先级：命令行 --mock > 环境变量 > 默认 sqlite。
   */
  dataSource: (process.argv.includes('--mock') ? 'mock' : (process.env.EMAKI_DATA_SOURCE ?? 'sqlite')) as DataSourceKind,
  /** 数据库、缩略图缓存、模型文件都放这里；已被 .gitignore 忽略 */
  dataDir,
  /** 生产模式下由后端直接托管前端构建产物 */
  webDist: path.join(repoRoot, 'apps/web/dist'),
  /** 随仓库分发的数据文件（离线对照表、词库） */
  assetsDir: path.join(repoRoot, 'apps/server/assets'),
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
  /** 出网代理（Clash 系统代理模式下 Node 不走系统代理，要写 http://127.0.0.1:7890） */
  httpProxy: process.env.EMAKI_HTTP_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null,
  /** 开发时可指向 https://testbooru.donmai.us；离线测试可指向 http://127.0.0.1:9 */
  danbooruBaseUrl: process.env.EMAKI_DANBOORU_URL ?? 'https://danbooru.donmai.us',
  appVersion: (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version,
  /** User-Agent 里的项目地址；上传 GitHub 后填真实地址 */
  appRepoUrl: 'https://github.com/nickname21kmr/emaki',
} as const;
