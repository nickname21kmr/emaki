/**
 * 插件视图用的库 /plugin-sdk/app.js（docs/plugins.md 第 5 节、src/plugin-sdk/sdk.ts）：打成一个 IIFE（全局 Emaki），
 * 开发时由 vite 直接给（改了 src/plugin-sdk/ 下的文件重新打），构建时放进 dist/plugin-sdk/app.js（服务端在 Claude 里打开页面时内联它）。
 * 不进网页的主包：只有插件视图的 iframe 加载它。
 */
import path from 'node:path';
import { build, type Plugin } from 'vite';

const DIR = path.resolve(import.meta.dirname, 'src/plugin-sdk');
const ENTRY = path.join(DIR, 'sdk.ts');
export const PLUGIN_SDK_URL = '/plugin-sdk/app.js';

async function bundle(): Promise<string> {
  const out = await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    build: {
      write: false,
      emptyOutDir: false,
      minify: true,
      sourcemap: false,
      lib: { entry: ENTRY, formats: ['iife'], name: 'Emaki', fileName: () => 'app.js' },
    },
  });
  const results = Array.isArray(out) ? out : [out];
  for (const r of results) if ('output' in r) for (const o of r.output) if (o.type === 'chunk' && o.isEntry) return o.code;
  throw new Error('plugin-sdk：没有打出 app.js');
}

export function pluginSdk(): Plugin {
  let code: Promise<string> | null = null;
  const get = () => (code ??= bundle());
  return {
    name: 'emaki-plugin-sdk',
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (file.startsWith(DIR)) code = null;
      });
      server.middlewares.use(PLUGIN_SDK_URL, (_req, res, next) => {
        get().then(
          (js) => {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(js);
          },
          (e: unknown) => next(e),
        );
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: PLUGIN_SDK_URL.slice(1), source: await get() });
    },
  };
}
