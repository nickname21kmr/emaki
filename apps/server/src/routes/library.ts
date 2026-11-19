import type { FastifyInstance } from 'fastify';
import * as S from '@emaki/shared/schemas';
import type { CharacterData, LibraryData } from '../datasource/DataSource.ts';
import { NotFoundError } from '../http/errors.ts';
import { idParam, parse } from '../http/validate.ts';

/** 统计、作品、角色、搜索 */
export function libraryRoutes(app: FastifyInstance, ds: LibraryData & CharacterData): void {
  app.get('/api/stats', () => ds.getStats());
  app.get('/api/content-kinds', () => ds.listContentKinds());

  // ---------------------------------------------------------- 作品

  app.get('/api/works', (req) => {
    return ds.listWorks(parse(S.listWorksQuery, req.query));
  });

  app.get('/api/works/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const work = await ds.getWork(id);
    if (!work) throw new NotFoundError('作品');
    return work;
  });

  // ---------------------------------------------------------- 角色

  app.get('/api/characters', (req) => ds.listCharacters(parse(S.listCharactersQuery, req.query)));

  app.get('/api/characters/top', (req) => ds.topCharacters(parse(S.topCharactersQuery, req.query)));

  app.get('/api/characters/danbooru-matches', () => ds.listCustomCharacterMatches());

  app.get('/api/characters/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await ds.getCharacter(id);
    if (!res) throw new NotFoundError('角色');
    return res;
  });

  // 「换封面」候选（CB-7）
  app.get('/api/characters/:id/cover-candidates', (req) => {
    const { id } = parse(idParam, req.params);
    const { limit } = parse(S.coverCandidatesQuery, req.query);
    return ds.listCoverCandidates(id, limit ?? 12);
  });

  app.post('/api/characters', (req) => ds.createCharacter(parse(S.createCharacterBody, req.body)));

  app.patch('/api/characters/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.updateCharacter(id, parse(S.updateCharacterBody, req.body));
  });

  app.post('/api/characters/:id/seen', async (req) => {
    const { id } = parse(idParam, req.params);
    await ds.markCharacterSeen(id);
    return { ok: true };
  });

  app.post('/api/characters/:id/merge', (req) => {
    const { id } = parse(idParam, req.params);
    const { targetId } = parse(S.mergeCharacterBody, req.body);
    return ds.mergeCharacter(id, targetId);
  });

  // ---------------------------------------------------------- 搜索

  app.get('/api/search', (req) => ds.search(parse(S.searchQuery, req.query)));

  app.get('/api/tags', (req) => ds.tagSuggestions(parse(S.tagSuggestionsQuery, req.query)));
}
