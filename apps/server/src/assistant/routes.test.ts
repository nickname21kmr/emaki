import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../config.ts', async importOriginal => {
  const { config } = await importOriginal<typeof import('../config.ts')>();
  return { config: { ...config, get dataDir() { return state.dir; }, dataSource: 'mock', webDist: '/nonexistent' } };
});
import { buildApp } from '../app.ts';
import { EventBus } from '../core/events.ts';
import { MockDataSource } from '../datasource/mock/MockDataSource.ts';

let app: FastifyInstance, base: string, token: string, imageId: string;
let piSession: string, holdResponse = false;
const providerRequests: any[] = [];
const provider = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body); providerRequests.push(input);
  const tools = input.tools ?? [];
  const hasToolResponse = input.messages.some((m: any) => m.role === 'tool');
  const probe = input.messages.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('__permission_probe__'));
  const name = tools.find((t: any) => probe ? t.function?.name === 'write' : t.function?.name.endsWith('query_database'))?.function.name;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (holdResponse) { res.flushHeaders(); return; }
  const chunk = (delta: any, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (!hasToolResponse && name) {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'query-1', type: 'function', function: { name, arguments: JSON.stringify(probe ? { path: 'permission-probe.txt', content: 'fixture only' } : { sql: 'SELECT count(*) AS n FROM images', limit: 10 }) } }] }); chunk({}, 'tool_calls');
  } else { chunk({ role: 'assistant', content: 'fixture-response: MCP 查询完成' }); chunk({}, 'stop'); }
  res.end('data: [DONE]\n\n');
});
const call = async (method: any, url: string, payload?: unknown) => app.inject({ method, url: '/api/assistant' + url, headers: { host: 'localhost', 'content-type': 'application/json' }, payload: payload as any });
beforeAll(async () => {
  state.dir = mkdtempSync(path.join(tmpdir(), 'emaki-route-test-'));
  const db = new Database(path.join(state.dir, 'emaki.sqlite')); db.exec('CREATE TABLE images(id INTEGER PRIMARY KEY); INSERT INTO images VALUES(1),(2);'); db.close();
  const bus = new EventBus(), ds = new MockDataSource(bus); imageId = (await ds.listImages({ limit: 1 })).items[0]!.id;
  app = await buildApp(ds, bus); base = await app.listen({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => { await app.close(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(state.dir, { recursive: true, force: true, maxRetries: 4 }); });
describe('assistant HTTP and MCP', () => {
  it('does not expose sessions or tools while disabled', async () => {
    expect((await call('GET', '/settings')).json().enabled).toBe(false);
    expect((await call('POST', '/sessions', {})).statusCode).toBe(403);
    expect((await call('POST', '/mcp', {})).statusCode).toBe(403);
    expect((await call('POST', '/detect', {})).statusCode).toBe(403);
  });
  it('validates and persists access mode without exposing credentials', async () => {
    expect((await call('GET', '/settings')).json().accessMode).toBe('ask');
    expect((await call('PATCH', '/settings', { accessMode: 'invalid' })).statusCode).toBe(400);
    const full = (await call('PATCH', '/settings', { accessMode: 'full' })).json();
    expect(full.accessMode).toBe('full'); expect(full).not.toHaveProperty('apiKey'); expect(full).not.toHaveProperty('externalToken');
    expect((await call('GET', '/settings')).json().accessMode).toBe('full');
    await call('PATCH', '/settings', { accessMode: 'ask' });
  });
  it('serves standard MCP and mutations through the normal datasource', async () => {
    await call('PATCH', '/settings', { enabled: true, backend: 'pi' });
    token = (await call('GET', '/mcp-config')).json().token;
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/api/assistant/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    expect((await client.listTools()).tools.map(t => t.name)).toContain('query_database');
    const result: any = await client.callTool({ name: 'query_database', arguments: { sql: 'SELECT count(*) AS n FROM images' } });
    expect(JSON.parse(result.content[0].text).rows).toEqual([{ n: 2 }]);
    const media: any = await client.callTool({ name: 'read_media', arguments: { imageId } });
    expect(media.content[0].type).toBe('image');
    expect(Buffer.from(media.content[0].data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const body = { operationId: 'test-favorite', ids: [imageId], action: { type: 'favorite', value: true } };
    const changed: any = await client.callTool({ name: 'update_images', arguments: body });
    expect(changed.isError).not.toBe(true);
    expect(await client.callTool({ name: 'update_images', arguments: body })).toEqual(changed);
    const img = (await app.inject({ url: `/api/images/${imageId}`, headers: { host: 'localhost' } })).json(); expect(img.favorite).toBe(true);
    await client.close();
  });
  it('edits sources through MCP with validation, retry deduplication and undo', async () => {
    const client = new Client({ name: 'source-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/api/assistant/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const read = async () => (await app.inject({ url: `/api/images/${imageId}`, headers: { host: 'localhost' } })).json();
    const before = await read();
    try {
      const args = { operationId: 'source-fixture', imageId, source: { url: 'https://www.pixiv.net/artworks/98785437', artist: 'Killy' } };
      const result: any = await client.callTool({ name: 'edit_source', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(await client.callTool({ name: 'edit_source', arguments: args })).toEqual(result);
      expect(await read()).toMatchObject({ sourceManual: true, source: { postId: '98785437' } });
      const invalid = await app.inject({ method: 'PATCH', url: `/api/images/${imageId}`, headers: { host: 'localhost', 'content-type': 'application/json' }, payload: { source: { url: 'file:///C:/test' } } });
      expect(invalid.statusCode).toBe(400);
      expect((await read()).source.postId).toBe('98785437');
      const { undoToken } = JSON.parse(result.content[0].text);
      expect((await app.inject({ method: 'POST', url: `/api/undo/${undoToken}`, headers: { host: 'localhost', 'content-type': 'application/json' }, payload: {} })).statusCode).toBe(200);
      expect(await read()).toMatchObject({ source: before.source, sourceManual: before.sourceManual });
    } finally { await client.close(); }
  });
  it('accepts a real suggestion through MCP, deduplicates retry and supports normal undo', async () => {
    const pending = (await app.inject({ url: '/api/unrecognized?area=art&bucket=suggested&limit=1', headers: { host: 'localhost' } })).json().items[0];
    expect(pending).toBeTruthy();
    const imagePath = `/api/images/${pending.image.id}`;
    const before = (await app.inject({ url: imagePath, headers: { host: 'localhost' } })).json();
    const suggestion = before.characterSuggestions[0];
    expect(suggestion.danbooruTag).toBeTruthy();
    const client = new Client({ name: 'accept-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/api/assistant/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      const args = { operationId: 'accept-fixture', imageId: pending.image.id, danbooruTag: suggestion.danbooruTag };
      const result: any = await client.callTool({ name: 'accept_suggestion', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(await client.callTool({ name: 'accept_suggestion', arguments: args })).toEqual(result);
      const after = (await app.inject({ url: imagePath, headers: { host: 'localhost' } })).json();
      expect(after.characterIds).toContain(suggestion.characterId);
      expect(after.status).toBe('recognized');
      const { undoToken } = JSON.parse(result.content[0].text);
      expect(undoToken).toBeTruthy();
      expect((await app.inject({ method: 'POST', url: `/api/undo/${undoToken}`, headers: { host: 'localhost', 'content-type': 'application/json' }, payload: {} })).statusCode).toBe(200);
      const restored = (await app.inject({ url: imagePath, headers: { host: 'localhost' } })).json();
      expect(restored.characterIds).toEqual(before.characterIds);
      expect(restored.characterSuggestions).toEqual(before.characterSuggestions);
    } finally { await client.close(); }
  });
  it('runs the real Pi harness against a fixture API, including an MCP round trip', async () => {
    const address = provider.address() as { port: number };
    await call('PATCH', '/settings', { pi: { provider: '', api: 'openai-completions', model: 'fixture-model', baseUrl: `http://127.0.0.1:${address.port}/v1` }, apiKey: 'fixture-key' });
    const session = (await call('POST', '/sessions', {})).json();
    piSession = session.id;
    expect((await call('GET', '/sessions/00000000-0000-4000-8000-000000000001')).statusCode).toBe(404);
    const models = (await call('GET', `/sessions/${session.id}/models`)).json();
    expect(models.some((m: any) => m.id === 'emaki/fixture-model')).toBe(true);
    const input = { requestId: '00000000-0000-4000-8000-000000000002', text: 'Count images using MCP', model: 'emaki/fixture-model', effort: '', context: { page: '/gallery', imageIds: [imageId] } };
    expect((await call('POST', `/sessions/${session.id}/messages`, input)).statusCode).toBe(200);
    await call('POST', `/sessions/${session.id}/messages`, input);
    let finished: any;
    for (let i = 0; i < 100; i++) { finished = (await call('GET', `/sessions/${session.id}`)).json(); if (finished.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
    expect(finished.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
    expect(finished.status, JSON.stringify(finished)).toBe('idle');
    expect(finished.messages.some((m: any) => m.text.includes('fixture-response'))).toBe(true);
    expect(providerRequests.some(r => r.messages.some((m: any) => m.role === 'tool' && String(m.content).includes('"n":2')))).toBe(true);
    const system = providerRequests.flatMap(r => r.messages).filter((m: any) => m.role === 'system').map((m: any) => JSON.stringify(m.content)).join('\n');
    // The real Pi process must advertise both skills without eagerly loading their bodies.
    expect(system).toContain('<name>emaki-library</name>');
    expect(system).toContain('<name>taste-profile</name>');
    expect(system).not.toContain('查源采用');
    expect(finished).not.toHaveProperty('nativeId'); expect(finished).not.toHaveProperty('token');
  }, 20000);
  it('keeps running after SSE disconnect, stops, and resumes its own Pi history', async () => {
    holdResponse = true;
    const count = providerRequests.length;
    const input = { requestId: '00000000-0000-4000-8000-000000000003', text: 'Waiting turn', model: 'emaki/fixture-model', context: { page: '/characters', imageIds: [] } };
    await call('POST', `/sessions/${piSession}/messages`, input);
    for (let i = 0; i < 100 && providerRequests.length === count; i++) await new Promise(r => setTimeout(r, 50));
    expect(providerRequests.length).toBeGreaterThan(count);
    const abort = new AbortController();
    const stream = await fetch(`${base}/api/assistant/sessions/${piSession}/events`, { signal: abort.signal });
    const { value } = await stream.body!.getReader().read();
    expect(new TextDecoder().decode(value)).toContain('Waiting turn');
    abort.abort();
    expect((await call('GET', `/sessions/${piSession}`)).json().status).toBe('running');
    await call('POST', `/sessions/${piSession}/stop`, {});
    expect((await call('GET', `/sessions/${piSession}`)).json().status).toBe('idle');
    holdResponse = false;
    expect((await call('GET', `/sessions/${piSession}`)).json().interruption.messageId).toBe(input.requestId);
    const resume = { requestId: '00000000-0000-4000-8000-000000000004', messageId: input.requestId, model: input.model, effort: '' };
    expect((await call('POST', `/sessions/${piSession}/resume`, resume)).statusCode).toBe(200);
    expect((await call('POST', `/sessions/${piSession}/resume`, resume)).statusCode).toBe(200);
    let finished: any;
    for (let i = 0; i < 100; i++) { finished = (await call('GET', `/sessions/${piSession}`)).json(); if (finished.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
    expect(finished.status, JSON.stringify(finished)).toBe('idle');
    expect(finished.messages.filter((m: any) => m.role === 'user')).toHaveLength(3);
    expect(finished.interruption).toBeUndefined();
    expect(finished.messages.find((m: any) => m.id === resume.requestId).context).toEqual(input.context);
    expect(providerRequests.at(-1).messages.some((m: any) => JSON.stringify(m.content).includes('Count images using MCP'))).toBe(true);
  }, 20000);
  it('Pi asks before a file write in ask mode and runs it directly in full mode', async () => {
    for (const accessMode of ['ask', 'full']) {
      await call('PATCH', '/settings', { accessMode });
      const session = (await call('POST', '/sessions', {})).json();
      await call('POST', `/sessions/${session.id}/messages`, { requestId: crypto.randomUUID(), text: '__permission_probe__', model: 'emaki/fixture-model', context: { page: '/gallery', imageIds: [] } });
      let snapshot: any;
      for (let i = 0; i < 100; i++) {
        snapshot = (await call('GET', `/sessions/${session.id}`)).json();
        if (snapshot.status !== 'running') break;
        await new Promise(r => setTimeout(r, 50));
      }
      const file = path.join(state.dir, 'assistant/workspaces', session.id, 'permission-probe.txt');
      if (accessMode === 'ask') {
        expect(snapshot.status, JSON.stringify(snapshot)).toBe('waiting');
        expect(snapshot.questions[0].kind).toBe('approval');
        expect(existsSync(file)).toBe(false);
        expect((await call('POST', `/sessions/${session.id}/stop`, {})).statusCode).toBe(200);
      } else {
        expect(snapshot.status, JSON.stringify(snapshot)).toBe('idle');
        expect(snapshot.questions).toHaveLength(0);
        expect(readFileSync(file, 'utf8')).toBe('fixture only');
      }
    }
  }, 20000);
  it('disables the running backend and rejects old MCP credentials while off', async () => {
    await call('PATCH', '/settings', { enabled: false });
    expect((await call('GET', '/sessions')).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/api/assistant/mcp', headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});
