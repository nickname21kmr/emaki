import type { ServerEvent } from '@emaki/shared';
import { rmSync } from 'node:fs';
import { describe } from 'vitest';
import { EventBus } from '../../src/core/events.ts';
import { seedDatabase, type IdMap } from '../../src/demo/seed.ts';
import { SqliteDataSource } from '../../src/datasource/sqlite/SqliteDataSource.ts';
import { buildContractDb } from '../fixtures/contract-db.ts';
import { makeTmpDir } from '../helpers/tmp.ts';

export type Kind = 'root' | 'work' | 'character' | 'image' | 'exclusion' | 'duplicate';

export interface ContractEnv {
  ds: SqliteDataSource;
  bus: EventBus;
  /** 订阅 bus 收集的事件 */
  events: ServerEvent[];
  now: number;
  /** 夹具 id（i1 / c1 …）→ sqlite id */
  id(kind: Kind, fixtureId: string): string;
  /** 反向，断言时把输出换回夹具 id */
  back(kind: Kind, id: string): string;
  close(): Promise<void>;
}

export type ContractFactory = () => Promise<ContractEnv>;

export const NOW = Date.parse('2026-09-27T12:00:00.000Z');

function collect(bus: EventBus): ServerEvent[] {
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

const KIND_KEYS: Record<Kind, keyof IdMap> = {
  root: 'roots',
  work: 'works',
  character: 'characters',
  image: 'images',
  exclusion: 'exclusions',
  duplicate: 'duplicates',
};

export const sqliteFactory: ContractFactory = async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const dataDir = makeTmpDir('contract');
  // 夹具里的 D:/Pics 不一定存在：不查盘符，假回收站什么也不做（文件本来就不在）
  const ds = await SqliteDataSource.open(bus, dataDir, {
    memory: true,
    clock: () => NOW,
    autoJobs: false,
    importDict: false,
    checkRecyclable: async () => {},
    trashImpl: async () => {},
  });
  const map = seedDatabase(ds.ctx.db, buildContractDb(NOW), { now: NOW });
  ds.ctx.invalidate();
  const reverse = new Map<string, Map<string, string>>();
  for (const [kind, key] of Object.entries(KIND_KEYS)) {
    reverse.set(kind, new Map([...map[key]].map(([fixtureId, n]) => [String(n), fixtureId])));
  }
  return {
    ds,
    bus,
    events,
    now: NOW,
    id: (kind, fixtureId) => {
      const n = map[KIND_KEYS[kind]].get(fixtureId);
      if (n === undefined) throw new Error(`夹具里没有 ${kind} ${fixtureId}`);
      return String(n);
    },
    // 新建的实体（夹具里没有）原样返回，断言时自己处理
    back: (kind, id) => reverse.get(kind)!.get(id) ?? id,
    close: async () => {
      await ds.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 按对象形状判断里面哪些字段是哪种 id */
function idFields(o: Obj): Partial<Record<string, Kind>> {
  if ('relPath' in o) return { id: 'image', libraryRootId: 'root', characterIds: 'character', workIds: 'work' };
  if ('characterCount' in o) return { id: 'work', coverImageId: 'image' };
  if ('source' in o && 'danbooruTag' in o && 'workIds' in o) return { id: 'character', workIds: 'work', coverImageId: 'image' };
  if ('path' in o && 'enabled' in o) return { id: 'root' };
  if ('label' in o && 'target' in o) return { id: 'exclusion', previewImageIds: 'image' };
  if ('suggestedKeepId' in o) return { id: 'duplicate', suggestedKeepId: 'image' };
  if ('characterId' in o && 'danbooruTag' in o) return { characterId: 'character' };
  return {};
}

/** 把输出里的所有 id 换回夹具 id，便于断言和快照 */
export function canon<T>(env: ContractEnv, value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const fields = idFields(v);
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const kind = fields[k];
      if (kind && typeof x === 'string') out[k] = env.back(kind, x);
      else if (kind && Array.isArray(x)) out[k] = x.map((y) => (typeof y === 'string' ? env.back(kind, y) : y));
      else out[k] = walk(x);
    }
    // 排除规则里 image / character 类的 target 也是 id
    if ('label' in v && 'target' in v && typeof v.target === 'string') {
      if (v.kind === 'image') out.target = env.back('image', v.target);
      if (v.kind === 'character') out.target = env.back('character', v.target);
    }
    return out;
  };
  return walk(value) as T;
}

/** 一组用例，标题带任务编号 */
export function contract(task: string, title: string, body: () => void): void {
  describe(`${title}（${task}）`, body);
}
