import { buildApp } from './app.ts';
import { config } from './config.ts';
import { EventBus } from './core/events.ts';
import type { DataSource } from './datasource/DataSource.ts';
import { KeepAwake } from './services/system/keepAwake.ts';

async function createDataSource(bus: EventBus): Promise<DataSource> {
  if (config.dataSource === 'sqlite') {
    // 动态 import：mock 模式下不需要装 better-sqlite3 / sharp 这些原生依赖
    const { SqliteDataSource } = await import('./datasource/sqlite/SqliteDataSource.ts');
    return SqliteDataSource.open(bus, config.dataDir);
  }
  const { MockDataSource } = await import('./datasource/mock/MockDataSource.ts');
  return new MockDataSource(bus);
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
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, async () => {
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
