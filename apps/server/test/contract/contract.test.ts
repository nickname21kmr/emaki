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
import { mockFactory, sqliteFactory } from './harness.ts';

describe.each([
  ['mock', mockFactory],
  ['sqlite', sqliteFactory],
] as const)('%s', (name, make) => {
  settingsContract(make, name);
  statsContract(make, name);
  worksContract(make, name);
  charactersContract(make, name);
  characterMutationsContract(make, name);
  unrecognizedContract(make, name);
  exclusionsContract(make, name);
  searchContract(make, name);
  imagesContract(make, name);
  duplicatesContract(make, name);
  bulkContract(make, name);
  undoContract(make, name);
  kindsContract(make, name);
  collectionsContract(make, name);
});
