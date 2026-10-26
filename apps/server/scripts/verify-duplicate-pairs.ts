/** Run labelled original pairs from a local library; no library writes and no network requests. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { compareImages, COMPARISON_VERSION, type ImageComparison } from '../src/services/dedupe/compareImages.ts';

interface Case {
  name: string;
  set: string;
  expected: 'variant' | 'copy' | 'pixels';
  sha256: [string, string];
}

const [database, manifest, output] = process.argv.slice(2);
if (!database || !manifest || !output) throw new Error('Usage: node --import tsx verify-duplicate-pairs.ts <database> <manifest> <output-json>');
const { cases } = JSON.parse(await readFile(manifest, 'utf8')) as { cases: Case[] };
const db = new Database(database, { readonly: true, fileMustExist: true });
const file = db.prepare('SELECT r.path AS root, i.rel_path FROM v_counted_images i JOIN library_roots r ON r.id=i.root_id WHERE i.sha256=? ORDER BY i.id LIMIT 1');
const results: (Pick<Case, 'name' | 'set' | 'expected'> & Partial<ImageComparison> & { passed: boolean; missing?: boolean })[] = [];
try {
  for (const c of cases) {
    const sources = c.sha256.map(sha => file.get(sha) as { root: string; rel_path: string } | undefined);
    if (sources.some(s => !s)) { results.push({ name: c.name, set: c.set, expected: c.expected, missing: true, passed: false }); continue; }
    const result = await compareImages(...sources.map(s => path.join(s!.root, s!.rel_path)) as [string, string]);
    const passed = c.expected === 'variant' ? result.match === null : c.expected === 'pixels' ? result.match === 'pixels' : result.match !== null;
    results.push({ name: c.name, set: c.set, expected: c.expected, ...result, passed });
  }
} finally { db.close(); }
const summary = Object.fromEntries([...new Set(cases.map(c => c.set))].map(set => {
  const rows = results.filter(r => r.set === set);
  return [set, { total: rows.length, passed: rows.filter(r => r.passed).length, missing: rows.filter(r => 'missing' in r && r.missing).length }];
}));
await writeFile(output, JSON.stringify({ version: COMPARISON_VERSION, summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (results.some(r => !r.passed)) process.exitCode = 1;
