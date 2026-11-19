/** 自动合并猜错了：手动拆开 / 合并画师，或者恢复自动（可撤销）。查询见 artists.ts */
import type { MutationResult, UpdateArtistLinksBody } from '@emaki/shared';
import { BadRequestError } from '../../http/errors.ts';
import { artistLinksMessage, linkTags, planArtistLinks } from '../artistEdits.ts';
import { artistNames, linkGroups, tagNames } from './artists.ts';
import type { SqliteContext } from './context.ts';
import { iso } from './sql.ts';

export function updateArtistLinks(ctx: SqliteContext, body: UpdateArtistLinksBody): MutationResult {
  const db = ctx.db;
  const into = body.mode === 'merge' ? body.into?.trim() : undefined;
  if (body.mode === 'merge' && !into) throw new BadRequestError('要合并到哪位画师？');
  const given = linkTags(body.tags, into);
  const { groups } = linkGroups(db, [...given, ...(into ? [into] : [])]);
  const tags = planArtistLinks(body.mode, given, into, groups);
  const names = body.mode === 'split' ? tagNames(db, tags) : artistNames(db, given);
  const intoName = into ? artistNames(db, [into])[0] : undefined;
  const json = JSON.stringify(tags);
  const now = iso(ctx.clock());
  return ctx.mutate((u) => {
    u.set('artist_links', 'tag IN (SELECT value FROM json_each(?))', [json]);
    db.prepare('DELETE FROM artist_links WHERE tag IN (SELECT value FROM json_each(?))').run(json);
    if (body.mode !== 'auto') {
      const ins = db.prepare('INSERT INTO artist_links (tag, group_tag, created_at) VALUES (?, ?, ?)');
      for (const t of tags) ins.run(t, into ?? null, now);
    }
    return { message: artistLinksMessage(body.mode, names, intoName) };
  });
}
