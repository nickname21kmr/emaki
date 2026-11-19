import type { ListArtistsResponse } from '@emaki/shared';
import type { FastifyInstance } from 'fastify';
import * as S from '@emaki/shared/schemas';
import type { ArtistData, CollectionData } from '../datasource/DataSource.ts';
import { NotFoundError } from '../http/errors.ts';
import { idParam, parse } from '../http/validate.ts';

/** 合集（T38c） */
export function collectionRoutes(app: FastifyInstance, ds: CollectionData & ArtistData): void {
  app.get('/api/collections', (req) => ds.listCollections(parse(S.listCollectionsQuery, req.query)));

  app.get('/api/artists', (): Promise<ListArtistsResponse> => ds.listArtists());
  app.post('/api/artists/links', (req) => ds.updateArtistLinks(parse(S.updateArtistLinksBody, req.body)));

  app.post('/api/collections/bulk', (req) => ds.bulkCollections(parse(S.bulkCollectionsBody, req.body)));

  app.get('/api/collections/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const res = await ds.getCollection(id);
    if (!res) throw new NotFoundError('合集');
    return res;
  });

  app.post('/api/collections', (req) => ds.createCollection(parse(S.createCollectionBody, req.body)));

  app.patch('/api/collections/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.updateCollection(id, parse(S.updateCollectionBody, req.body));
  });

  app.delete('/api/collections/:id', (req) => {
    const { id } = parse(idParam, req.params);
    return ds.deleteCollection(id);
  });
}
