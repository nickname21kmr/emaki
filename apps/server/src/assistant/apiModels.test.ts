import { createServer } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fetchApiModels } from './apiModels.ts';
import type { PrivateSettings } from './store.ts';

const requests: { url: string; auth?: string; key?: string; version?: string }[] = [];
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://local');
  requests.push({ url: req.url!, auth: req.headers.authorization, key: req.headers['x-api-key'] as string, version: req.headers['anthropic-version'] as string });
  if (url.pathname === '/redirect/models') { res.writeHead(302, { Location: '/unexpected/models' }); res.end(); return; }
  if (url.pathname === '/denied/models') { res.writeHead(401); res.end('secret-upstream-body'); return; }
  if (url.pathname === '/missing/models') { res.writeHead(404); res.end(); return; }
  if (url.pathname === '/invalid/models') { res.end('<html>login</html>'); return; }
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/anthropic/v1/models') {
    const next = url.searchParams.get('after_id');
    res.end(JSON.stringify({ data: [{ id: next ? 'second' : 'first', display_name: next ? 'Second model' : 'First model' }], has_more: !next, last_id: next ? 'second' : 'first' })); return;
  }
  res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b', name: 'Model B' }, { id: 'model-a' }] }));
});
let base: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const settings = (): PrivateSettings => ({ apiKey: 'saved-key', pi: { baseUrl: `${base}/v1` } } as PrivateSettings);

it.each(['openai-completions', 'openai-responses'] as const)('lists %s models with a draft key, without mutating configuration', async api => {
  const saved = settings(), before = structuredClone(saved);
  expect(await fetchApiModels({ baseUrl: `${base}/v1/`, api, apiKey: 'draft-key' }, saved)).toEqual([{ id: 'model-a', name: 'model-a' }, { id: 'model-b', name: 'Model B' }]);
  expect(requests.at(-1)).toMatchObject({ url: '/v1/models', auth: 'Bearer draft-key' });
  expect(saved).toEqual(before);
});
it('reuses the stored key only for the same origin and supports an explicit unauthenticated request', async () => {
  await fetchApiModels({ baseUrl: `${base}/v1`, api: 'openai-responses' }, settings());
  expect(requests.at(-1)?.auth).toBe('Bearer saved-key');
  await fetchApiModels({ baseUrl: `${base}/v1`, api: 'openai-responses', apiKey: '' }, settings());
  expect(requests.at(-1)?.auth).toBeUndefined();
  const count = requests.length;
  await expect(fetchApiModels({ baseUrl: base.replace('127.0.0.1', 'localhost'), api: 'openai-responses' }, settings())).rejects.toThrow('地址已更换');
  expect(requests).toHaveLength(count);
});
it('reads Anthropic pages with its own authentication and preserves display names', async () => {
  expect(await fetchApiModels({ baseUrl: `${base}/anthropic`, api: 'anthropic-messages', apiKey: 'anthropic-key' }, settings()))
    .toEqual([{ id: 'first', name: 'First model' }, { id: 'second', name: 'Second model' }]);
  expect(requests.at(-1)).toMatchObject({ url: '/anthropic/v1/models?limit=100&after_id=first', key: 'anthropic-key', version: '2023-06-01', auth: undefined });
});
it.each([['denied', '鉴权失败'], ['missing', '未提供模型列表'], ['invalid', '无法读取模型列表'], ['redirect', '无法读取模型列表']])('reports %s without exposing upstream bodies or following redirects', async (route, message) => {
  await expect(fetchApiModels({ baseUrl: `${base}/${route}`, api: 'openai-responses' }, settings())).rejects.toThrow(message);
  expect(requests.at(-1)?.url).toBe(`/${route}/models`);
});
