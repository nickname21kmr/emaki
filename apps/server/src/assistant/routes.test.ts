import { mkdtempSync, rmSync } from 'node:fs';
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
  const name = tools.find((t: any) => t.function?.name.endsWith('query_database'))?.function.name;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (holdResponse) { res.flushHeaders(); return; }
  const chunk = (delta: any, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (!hasToolResponse && name) {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'query-1', type: 'function', function: { name, arguments: JSON.stringify({ sql: 'SELECT count(*) AS n FROM images', limit: 10 }) } }] }); chunk({}, 'tool_calls');
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
    await call('POST', `/sessions/${piSession}/messages`, { ...input, requestId: '00000000-0000-4000-8000-000000000004', text: 'Resume after stop' });
    let finished: any;
    for (let i = 0; i < 100; i++) { finished = (await call('GET', `/sessions/${piSession}`)).json(); if (finished.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
    expect(finished.status, JSON.stringify(finished)).toBe('idle');
    expect(finished.messages.filter((m: any) => m.role === 'user')).toHaveLength(3);
    expect(providerRequests.at(-1).messages.some((m: any) => JSON.stringify(m.content).includes('Count images using MCP'))).toBe(true);
  }, 20000);
  it('disables the running backend and rejects old MCP credentials while off', async () => {
    await call('PATCH', '/settings', { enabled: false });
    expect((await call('GET', '/sessions')).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/api/assistant/mcp', headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});
