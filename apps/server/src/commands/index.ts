/**
 * 注册表里的全部命令和查询（docs/core-architecture.md 第 4.1 节）。加一个命令：在对应模块的文件里 defineCommand，再列到这里。
 */
import type { SqliteDataSource } from '../datasource/sqlite/SqliteDataSource.ts';
import { accessCommands, accessQueries } from './access.ts';
import { catalogCommands } from './catalog.ts';
import { curationCommands } from './curation.ts';
import { libraryCommands, libraryQueries } from './library.ts';
import { poseCommands, poseQueries } from './pose.ts';
import { queries } from './queries.ts';
import { Registry, type Def } from './registry.ts';
import { systemCommands, systemQueries } from './system.ts';
import { uploadCommands, uploadQueries } from './upload.ts';

export const DEFINITIONS: readonly Def[] = [
  ...curationCommands,
  ...catalogCommands,
  ...libraryCommands,
  ...systemCommands,
  ...queries,
  ...libraryQueries,
  ...systemQueries,
  ...poseCommands,
  ...poseQueries,
  ...accessCommands,
  ...accessQueries,
  ...uploadCommands,
  ...uploadQueries,
];

export function createRegistry(engine: SqliteDataSource): Registry {
  return new Registry(engine, DEFINITIONS);
}
