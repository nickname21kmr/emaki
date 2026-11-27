import { LanEntry } from './access/lan.ts';
import { buildApp } from './app.ts';
import { killAgentTreesSync } from './assistant/rpc.ts';
import { config } from './config.ts';
import { EventBus } from './core/events.ts';
import type { Settings } from '@emaki/shared';
import type { SqliteDataSource } from './datasource/sqlite/SqliteDataSource.ts';
import { InternalPlugins } from './services/plugins/internal.ts';
import { PluginRuntime } from './services/plugins/runtime/host.ts';
import { KeepAwake } from './services/system/keepAwake.ts';
import path from 'node:path';

/** 演示模式也跑真实引擎（docs/core-architecture.md 第 8 节）：换成演示数据和假部件，数据库在 data/demo（每次启动重建） */
async function openEngine(bus: EventBus): Promise<SqliteDataSource> {
  if (config.dataSource === 'demo') {
    const started = performance.now();
    const { openDemoEngine } = await import('./demo/engine.ts');
    const { ds } = await openDemoEngine(bus, { dir: config.libraryDir });
    console.log(`演示数据已就绪：${config.libraryDir}（${Math.round(performance.now() - started)} ms）`);
    return ds;
  }
  const { SqliteDataSource } = await import('./datasource/sqlite/SqliteDataSource.ts');
  return SqliteDataSource.open(bus, config.libraryDir);
}

const bus = new EventBus();
const ds = await openEngine(bus);
const app = await buildApp(ds, bus);
// 局域网入口（手机访问，docs/mobile.md 第 2 节）：默认关，设置里打开后立即生效；本机入口关掉时一起关
const lan = new LanEntry(ds, bus, { log: (m) => app.log.info(m) });
app.addHook('onClose', () => lan.close());
// 插件的服务端逻辑的子进程（listen 以后才起）
const plugins = new PluginRuntime(ds, { log: (m) => app.log.info(m) });
// 改内部的插件（docs/plugins.md 第 7 节）：在这个进程里加载，给登记过名字的内部点打补丁。
// 连着几次启动没跑稳（崩了、被强杀）就不加载、自动停用（第 8 节）：记在图库的数据目录里，演示数据不记
const internals = new InternalPlugins(ds, {
  log: (m) => app.log.info(m),
  ...(config.dataSource === 'sqlite' && { bootFile: path.join(ds.ctx.dataDir, 'plugins', 'internal-boot.json') }),
});
// 后台任务运行时不让电脑休眠（设置 → 识别里可关）；演示数据不需要
const awake =
  config.dataSource === 'sqlite'
    ? new KeepAwake(bus, { enabled: async () => (await ds.registry.query<Settings>('settings.get', {}, { actor: 'system:keepAwake' })).tagger.keepAwake, log: (m) => app.log.info(m) })
    : null;

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Emaki 后端已启动：http://${config.host}:${config.port}（数据源：${config.dataSource}）`);
  // 打不开（端口被占用等）不影响本机入口，原因记在「手机访问」的状态里
  await lan.start();
  // 改内部的插件先加载（补丁加上以后派生的数强刷新、网页重新取）；它改的点变了就不加载、自动停用。安全模式下不加载
  void internals.start();
  // 插件的服务端逻辑（docs/plugins.md 第 6 节）：每个插件一个子进程，插件变了自己起停；安全模式下不起
  plugins.start();
  // 优雅退出：关掉 HTTP 再关数据库（WAL 落盘）
  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    // 关黑色窗口时 Windows 发 SIGHUP，后端比 start.mjs 先收到，约 5 秒后就被强杀：先同步结束 agent 跑的脚本
    if (sig === 'SIGHUP') killAgentTreesSync();
    // 正常退出：先擦掉改内部的插件的启动记录（同步的，免得后面没做完就被强杀、下次当成崩了）
    internals.close();
    awake?.close();
    await app.close();
    await plugins.close();
    await ds.close();
    process.exit(0);
  };
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
  for (const sig of signals) process.once(sig, () => void shutdown(sig));
  // Windows 上没有信号：npm run dev 的 dev-watch.mjs 改了代码要重启时发这条消息，让后端正常退出（不然只能强杀）
  process.on('message', (m) => {
    if ((m as { type?: string } | null)?.type === 'emaki:shutdown') void shutdown('message');
  });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
