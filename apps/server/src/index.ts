import { LanEntry } from './access/lan.ts';
import { buildApp } from './app.ts';
import { killAgentTreesSync } from './assistant/rpc.ts';
import { config } from './config.ts';
import { EventBus } from './core/events.ts';
import type { Settings } from '@emaki/shared';
import type { SqliteDataSource } from './datasource/sqlite/SqliteDataSource.ts';
import { KeepAwake } from './services/system/keepAwake.ts';
import { connectLauncher, listenWhenFree } from './system/launcher.ts';

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

// 由 scripts/start.mjs 启动时接上它（system/launcher.ts）；npm run dev、直接起后端时是 null。
// 应用窗口在启动途中就关了：库还没开好，没有要收尾的，直接退出
const launcher = connectLauncher();
let quit = (): void => process.exit(0);
launcher?.onShutdown(() => quit());

const bus = new EventBus();
const ds = await openEngine(bus);
const app = await buildApp(ds, bus);
// 局域网入口（手机访问，docs/mobile.md 第 2 节）：默认关，设置里打开后立即生效；本机入口关掉时一起关
const lan = new LanEntry(ds, bus, { log: (m) => app.log.info(m) });
app.addHook('onClose', () => lan.close());
// 页面开着的事件连接（SSE）不会自己结束，app.close() 会一直等它，后面的数据库就关不成：停止接新连接之前先全部断开
app.addHook('preClose', async () => app.server.closeAllConnections());
// 后台任务运行时不让电脑休眠（设置 → 识别里可关）；演示数据不需要
const awake =
  config.dataSource === 'sqlite'
    ? new KeepAwake(bus, { enabled: async () => (await ds.registry.query<Settings>('settings.get', {}, { actor: 'system:keepAwake' })).tagger.keepAwake, log: (m) => app.log.info(m) })
    : null;

/**
 * 优雅退出：关掉 HTTP 再关数据库（WAL 落盘）。信号和启动器的通知走的都是这一段。
 * hurry：约 5 秒后就会被强杀的两种情况，先同步结束 agent 跑的脚本——
 * 关黑色窗口（Windows 发 SIGHUP，后端比 start.mjs 先收到）、应用窗口关掉后启动器要求退出。
 */
let exiting = false;
async function shutdown(hurry: boolean): Promise<void> {
  if (exiting) return;
  exiting = true;
  if (hurry) killAgentTreesSync();
  awake?.close();
  await app.close();
  await ds.close();
  process.exit(0);
}

try {
  if (launcher) {
    // 启动器的启动页还占着这个端口：请它让出来；刚让出来的那一瞬可能还占不上，重试一小会儿
    await launcher.releasePort();
    await listenWhenFree(() => app.listen({ host: config.host, port: config.port }));
  } else await app.listen({ host: config.host, port: config.port });
  app.log.info(`Emaki 后端已启动：http://${config.host}:${config.port}（数据源：${config.dataSource}）`);
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
  for (const sig of signals) process.once(sig, () => void shutdown(sig === 'SIGHUP'));
  quit = () => void shutdown(true);
  // 打不开（端口被占用等）不影响本机入口，原因记在「手机访问」的状态里。
  // 不等它：建 https 应用加 mDNS 广播要 130–160 ms，正好压在首页第一批请求上；它自己排队、出错不抛，关的时候也会等它
  void lan.start();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
