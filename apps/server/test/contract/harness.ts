import type { ServerEvent } from '@emaki/shared';
import { rmSync } from 'node:fs';
import { describe } from 'vitest';
import { EventBus } from '../../src/core/events.ts';
import type { DataSource } from '../../src/datasource/DataSource.ts';
import { MockDataSource } from '../../src/datasource/mock/MockDataSource.ts';
import { seedFromMockDb, type IdMap } from '../../src/datasource/sqlite/seed.ts';
import { SqliteDataSource } from '../../src/datasource/sqlite/SqliteDataSource.ts';
import { buildContractDb } from '../fixtures/contract-db.ts';
import { makeTmpDir } from '../helpers/tmp.ts';
import { SQLITE_READY } from './ready.ts';

export type Kind = 'root' | 'work' | 'character' | 'image' | 'exclusion' | 'duplicate';

export interface ContractEnv {
  name: 'mock' | 'sqlite';
  ds: DataSource;
  /** 订阅 bus 收集的事件 */
  events: ServerEvent[];
  now: number;
  /** 夹具 mock id → 本实现 id */
  id(kind: Kind, mockId: string): string;
  /** 反向，用于比较输出 */
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

export const mockFactory: ContractFactory = async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ds = new MockDataSource(bus, { db: buildContractDb(NOW), now: NOW });
  return { name: 'mock', ds, events, now: NOW, id: (_k, x) => x, back: (_k, x) => x, close: async () => {} };
};

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
  const ds = await SqliteDataSource.open(bus, dataDir, { memory: true, clock: () => NOW, autoJobs: false, importDict: false });
  const map = seedFromMockDb(ds.ctx.db, buildContractDb(NOW), { now: NOW });
  ds.ctx.invalidate();
  const reverse = new Map<string, Map<string, string>>();
  for (const [kind, key] of Object.entries(KIND_KEYS)) {
    reverse.set(kind, new Map([...map[key]].map(([mockId, n]) => [String(n), mockId])));
  }
  return {
    name: 'sqlite',
    ds,
    events,
    now: NOW,
    id: (kind, mockId) => {
      const n = map[KIND_KEYS[kind]].get(mockId);
      if (n === undefined) throw new Error(`夹具里没有 ${kind} ${mockId}`);
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

/** 把输出里的所有 id 换回 mock id，便于两边 deep equal */
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

/** 契约分组：sqlite 这边只有 task 在 SQLITE_READY 里时才跑，否则 skip（mock 永远跑） */
export function contract(task: string, title: string, name: 'mock' | 'sqlite', body: () => void): void {
  const run = name === 'mock' || SQLITE_READY.has(task);
  (run ? describe : describe.skip)(`${title}（${task}）`, body);
}
