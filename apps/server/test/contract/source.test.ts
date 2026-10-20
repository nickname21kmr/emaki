import { describe, expect, it } from 'vitest';
import { mockFactory, sqliteFactory } from './harness.ts';
import { parseSource } from '../../src/services/source/parseSource.ts';

for (const [name, factory] of [['mock', mockFactory], ['sqlite', sqliteFactory]] as const) {
  describe(`${name} source editing`, () => {
    it('persists, clears, resets and undoes without changing character or artist associations', async () => {
      const env = await factory();
      try {
        const id = env.id('image', 'i1');
        const before = (await env.ds.getImage(id))!;
        const favorite = await env.ds.updateImage(id, { favorite: !before.favorite });
        const edit = await env.ds.updateImage(id, { source: { url: 'https://www.pixiv.net/artworks/98785437', artist: 'Killy' } });
        const confirmed = (await env.ds.getImage(id))!;
        expect(confirmed).toMatchObject({ sourceManual: true, source: { site: 'pixiv', postId: '98785437', artist: 'Killy' } });
        expect(confirmed.characterIds).toEqual(before.characterIds);
        expect(confirmed.artists).toEqual(before.artists);
        await env.ds.undo(favorite.undoToken!);
        expect(await env.ds.getImage(id)).toMatchObject({ source: confirmed.source, sourceManual: true });
        const clear = await env.ds.updateImage(id, { source: null });
        expect(await env.ds.getImage(id)).toMatchObject({ source: null, sourceManual: true });
        await env.ds.undo(clear.undoToken!);
        expect((await env.ds.getImage(id))!.source).toEqual(confirmed.source);
        const reset = await env.ds.updateImage(id, { source: 'auto' });
        expect(await env.ds.getImage(id)).toMatchObject({ source: parseSource(before.relPath), sourceManual: false });
        await env.ds.undo(reset.undoToken!);
        expect(await env.ds.getImage(id)).toMatchObject({ source: confirmed.source, sourceManual: true });
        await env.ds.undo(edit.undoToken!);
        expect(await env.ds.getImage(id)).toMatchObject({ source: before.source, sourceManual: before.sourceManual });
        await expect(env.ds.updateImage(id, { source: { url: 'javascript:alert(1)' } })).rejects.toThrow();
        expect((await env.ds.getImage(id))!.source).toEqual(before.source);
      } finally { await env.close(); }
    });
  });
}
