/** Danbooru 响应的 zod 校验（z.object 默认丢弃未知字段） */
import { z } from 'zod';

export const DanbooruCategory = { general: 0, artist: 1, copyright: 3, character: 4, meta: 5 } as const;

export const TAG_ONLY =
  'name,category,post_count,is_deprecated,antecedent_alias[consequent_name,status],antecedent_implications[consequent_name],consequent_aliases[antecedent_name]';

export const TagSchema = z.object({
  name: z.string(),
  category: z.number().int(),
  post_count: z.number().int(),
  is_deprecated: z.boolean().default(false),
  /** 这个标签本身已被 alias 到别的标签（旧名）时才有 */
  antecedent_alias: z.object({ consequent_name: z.string(), status: z.string() }).nullish(),
  antecedent_implications: z.array(z.object({ consequent_name: z.string() })).default([]),
  consequent_aliases: z.array(z.object({ antecedent_name: z.string() })).default([]),
});
export const AliasSchema = z.object({ antecedent_name: z.string(), consequent_name: z.string() });
export const WikiSchema = z.object({ title: z.string(), other_names: z.array(z.string()).default([]), is_deleted: z.boolean().default(false) });
const MiniTag = z.object({ name: z.string(), category: z.number().int(), post_count: z.number().int() });
export const RelatedSchema = z.object({
  query: z.string(),
  post_count: z.number(),
  tag: MiniTag.nullable(),
  related_tags: z.array(z.object({ tag: MiniTag, frequency: z.number() })),
});
export const AutocompleteSchema = z.object({
  type: z.string(),
  label: z.string().optional(),
  value: z.string(),
  category: z.number().int().optional(),
  post_count: z.number().int().optional(),
  antecedent: z.string().nullish(),
});

export type DbTag = z.infer<typeof TagSchema>;
export type DbAlias = z.infer<typeof AliasSchema>;
export type DbWiki = z.infer<typeof WikiSchema>;
export type DbRelated = z.infer<typeof RelatedSchema>;
export type DbAutocomplete = z.infer<typeof AutocompleteSchema>;
