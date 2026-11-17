/**
 * 演示模式（npm run dev:mock，命令行 --mock）：真实引擎 + 演示数据 + 假部件（docs/core-architecture.md 第 8 节）。
 *
 * - 数据目录每次打开前清空重建，用文件数据库（AI 助手的只读 SQL 直接读这个文件）；
 * - 灌入演示数据（buildDemoDb），再经过真实的启动步骤（合集重算等）；
 * - 图片是 SVG 占位图；后台任务只走进度条；不扫描、不监听、不跑模型、不联网；
 *   移动、导入、替换、显示在资源管理器、添加图库文件夹一律拒绝；回收站只记录。
 *
 * 测试也可以用它：给 memory: true 和固定时钟，换成契约夹具（HTTP 冒烟、AI 助手的路由测试）。
 */
import { rm } from 'node:fs/promises';
import type { EventBus } from '../core/events.ts';
import { SqliteDataSource } from '../datasource/sqlite/SqliteDataSource.ts';
import { buildDemoDb, type DemoDb } from './fixtures.ts';
import { demoPorts, type DemoPorts } from './ports.ts';
import { seedDemoDb, type IdMap } from './seed.ts';

export interface DemoEngineOptions {
  /** 数据目录（演示模式是 data/demo）；不是内存库时打开前整个清空 */
  dir: string;
  /** 演示数据；不给就按 now 生成默认的一份 */
  data?: DemoDb;
  /** 生成演示数据和灌数据用的「现在」 */
  now?: number;
  /** 引擎的时钟；不给就是真实时间 */
  clock?: () => number;
  /** 内存库（测试用）：不建文件，也不清空目录 */
  memory?: boolean;
  /** 假任务每一步的间隔（毫秒，默认 80，整个任务约 5 秒）；测试里调小 */
  jobStepMs?: number;
}

export interface DemoEngine {
  ds: SqliteDataSource;
  /** 演示数据 id → 库里的 id */
  map: IdMap;
  ports: DemoPorts;
}

export async function openDemoEngine(bus: EventBus, opts: DemoEngineOptions): Promise<DemoEngine> {
  const now = opts.now ?? Date.now();
  const data = opts.data ?? buildDemoDb(now);
  if (!opts.memory) await rm(opts.dir, { recursive: true, force: true, maxRetries: 3 });
  const ports = demoPorts(opts.clock, opts.jobStepMs);
  let map: IdMap | undefined;
  const ds = await SqliteDataSource.open(bus, opts.dir, {
    ...ports,
    memory: opts.memory,
    seed: (db) => {
      map = seedDemoDb(db, data, { now });
    },
  });
  ports.imageFiles.register(data, map!);
  return { ds, map: map!, ports };
}
