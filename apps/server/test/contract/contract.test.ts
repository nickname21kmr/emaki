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

settingsContract(sqliteFactory);
statsContract(sqliteFactory);
worksContract(sqliteFactory);
charactersContract(sqliteFactory);
characterMutationsContract(sqliteFactory);
unrecognizedContract(sqliteFactory);
exclusionsContract(sqliteFactory);
searchContract(sqliteFactory);
imagesContract(sqliteFactory);
duplicatesContract(sqliteFactory);
bulkContract(sqliteFactory);
undoContract(sqliteFactory);
kindsContract(sqliteFactory);
collectionsContract(sqliteFactory);
