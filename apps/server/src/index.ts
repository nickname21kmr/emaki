import { LanEntry } from './access/lan.ts';
import { buildApp } from './app.ts';
import { killAgentTreesSync } from './assistant/rpc.ts';
import { config } from './config.ts';
import { EventBus } from './core/events.ts';
import type { Settings } from '@emaki/shared';
import type { SqliteDataSource } from './datasource/sqlite/SqliteDataSource.ts';
import { KeepAwake } from './services/system/keepAwake.ts';

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
  // 优雅退出：关掉 HTTP 再关数据库（WAL 落盘）
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
  for (const sig of signals) {
    process.once(sig, async () => {
      // 关黑色窗口时 Windows 发 SIGHUP，后端比 start.mjs 先收到，约 5 秒后就被强杀：先同步结束 agent 跑的脚本
      if (sig === 'SIGHUP') killAgentTreesSync();
      awake?.close();
      await app.close();
      await ds.close();
      process.exit(0);
    });
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
