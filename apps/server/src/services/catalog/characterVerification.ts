import { z } from 'zod';
import type { Db, Statement } from '../../db/connection.ts';

const tag = z.string().trim().min(1).max(200).regex(/^[^\s:]+$/);
const evidence = {
  aliases: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  sources: z.array(z.url({ protocol: /^https?$/ }).max(2000)).min(1).max(8),
  evidence: z.string().trim().min(1).max(2000),
};
export const characterVerificationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('identity'), tag, characterTag: tag, relation: z.enum(['form', 'same-character']), ...evidence }),
  z.object({ type: z.literal('name'), tag, name: z.string().trim().min(1).max(100), ...evidence }),
]);
export type CharacterVerification = z.infer<typeof characterVerificationSchema>;

export class CharacterVerifications {
  private readonly names: Statement;
  private readonly forms = new Map<string, string>();
  private readonly members = new Map<string, { tag: string; aliases: string[] }[]>();
  revision = 0;

  constructor(private readonly db: Db) {
    this.names = db.prepare('SELECT name, aliases FROM character_verified_names WHERE tag = ?');
    this.reload();
  }

  reload(): void {
    this.forms.clear();
    this.members.clear();
    for (const row of this.db.prepare('SELECT tag, character_tag, aliases FROM character_verified_forms ORDER BY tag').all() as {
      tag: string; character_tag: string; aliases: string;
    }[]) {
      this.forms.set(row.tag, row.character_tag);
      const group = this.members.get(row.character_tag) ?? [];
      group.push({ tag: row.tag, aliases: JSON.parse(row.aliases) as string[] });
      this.members.set(row.character_tag, group);
    }
    this.revision++;
  }

  base(tag: string): string | undefined {
    return this.forms.get(tag);
  }

  formsOf(tag: string): readonly { tag: string; aliases: string[] }[] {
    return this.members.get(tag) ?? [];
  }

  preferred(tag: string): { name: string; aliases: string[] } | undefined {
    const row = this.names.get(tag) as { name: string; aliases: string } | undefined;
    return row && { name: row.name, aliases: JSON.parse(row.aliases) as string[] };
  }
}
