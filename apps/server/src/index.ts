import { buildApp } from './app.ts';
import { killAgentTreesSync } from './assistant/rpc.ts';
import { config } from './config.ts';
import { EventBus } from './core/events.ts';
import type { DataSource } from './datasource/DataSource.ts';
import { KeepAwake } from './services/system/keepAwake.ts';

/** 演示模式也跑真实引擎（docs/core-architecture.md 第 8 节）：换成演示数据和假部件，数据库在 data/demo（每次启动重建） */
async function createDataSource(bus: EventBus): Promise<DataSource> {
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
const ds = await createDataSource(bus);
const app = await buildApp(ds, bus);
// 后台任务运行时不让电脑休眠（设置 → 识别里可关）；演示数据不需要
const awake =
  config.dataSource === 'sqlite'
    ? new KeepAwake(bus, { enabled: async () => (await ds.getSettings()).tagger.keepAwake, log: (m) => app.log.info(m) })
    : null;

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Emaki 后端已启动：http://${config.host}:${config.port}（数据源：${config.dataSource}）`);
  // 优雅退出：关掉 HTTP 再关数据库（WAL 落盘）
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
  for (const sig of signals) {
    process.once(sig, async () => {
      // 关黑色窗口时 Windows 发 SIGHUP，后端比 start.mjs 先收到，约 5 秒后就被强杀：先同步结束 agent 跑的脚本
      if (sig === 'SIGHUP') killAgentTreesSync();
      awake?.close();
      await app.close();
      await ds.close?.();
      process.exit(0);
    });
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
