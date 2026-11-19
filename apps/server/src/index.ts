import { buildApp } from './app.ts';
import { killAgentTreesSync } from './assistant/rpc.ts';
import { config } from './config.ts';
import { EventBus } from './core/events.ts';
import type { DataSource } from './datasource/DataSource.ts';
import { SqliteDataSource } from './datasource/sqlite/SqliteDataSource.ts';
import { KeepAwake } from './services/system/keepAwake.ts';

async function createDataSource(bus: EventBus): Promise<DataSource> {
  if (config.dataSource === 'sqlite') return SqliteDataSource.open(bus, config.dataDir);
  // 演示图库：每次从头导入假数据；不扫描、不识别、不监听文件夹；移到回收站只改记录，演示图留在磁盘上下次接着用
  const { prepareDemo } = await import('./demo/demo.ts');
  const pictures = await prepareDemo({ dataDir: config.dataDir, picsDir: config.demoPicsDir });
  const ds = await SqliteDataSource.open(bus, config.dataDir, { autoJobs: false, trashImpl: async () => {}, waitForFile: pictures.waitForFile });
  void pictures.drawInBackground().catch((e) => console.error('[演示] 画图失败', e));
  return ds;
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
