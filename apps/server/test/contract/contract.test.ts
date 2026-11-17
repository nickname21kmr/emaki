/**
 * 契约测试入口：每组用例都在真实引擎（SqliteDataSource + 契约夹具）上跑一遍。
 * 外层的「sqlite」只是沿用以前的用例名（以前 mock 和 sqlite 各跑一遍），方便和历史结果对照。
 */
import { describe } from 'vitest';
import {
  bulkContract,
  characterMutationsContract,
  collectionsContract,
  charactersContract,
  duplicatesContract,
  exclusionsContract,
  imagesContract,
  searchContract,
  settingsContract,
  statsContract,
  kindsContract,
  undoContract,
  unrecognizedContract,
  worksContract,
} from './groups.ts';
import { sqliteFactory } from './harness.ts';

describe('sqlite', () => {
  for (const group of [
    settingsContract,
    statsContract,
    worksContract,
    charactersContract,
    characterMutationsContract,
    unrecognizedContract,
    exclusionsContract,
    searchContract,
    imagesContract,
    duplicatesContract,
    bulkContract,
    undoContract,
    kindsContract,
    collectionsContract,
  ]) {
    group(sqliteFactory);
  }
});
