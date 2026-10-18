/** IPC supervisor: cleans up the native server if the HTTP parent disconnects. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sharp } from '../image/sharpConfig.ts';
import { VLM_FILE_HASHES, VLM_PARALLEL, VLM_SCHEMA, parseVlmResponse, type VlmFiles } from './vlmDecision.ts';
import { VLM_PROMPT } from './vlmPrompt.ts';

let server: ChildProcess | undefined;
let url = '';
let logTail = '';
let stopping = false;
const key = randomBytes(32).toString('hex');
const stopped = new AbortController();
const send = (msg: object) => { if (process.connected) process.send?.(msg, () => {}); };

async function stop() {
  if (stopping) return;
  stopping = true; stopped.abort();
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { server?.kill('SIGKILL'); resolve(); }, 1500);
      server!.once('exit', () => { clearTimeout(timer); resolve(); });
      server!.kill();
    });
  }
  send({ type: 'server-stopped' });
  process.exit(0);
}
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close(e => e ? reject(e) : resolve()));
  return port;
}
async function completion(body: object) {
  if (!server || server.exitCode !== null || server.signalCode !== null) throw new Error('llama.cpp 已退出：' + logTail.slice(-600));
  const r = await fetch(url + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body), signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(80_000)]),
  });
  if (!r.ok) throw new Error('llama.cpp HTTP ' + r.status);
  const value = await r.json() as any;
  const choice = value.choices?.[0];
  if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new Error('分类响应未完整结束');
  return JSON.parse(choice.message.content);
}
async function init(files: VlmFiles) {
  for (const field of ['model', 'projector'] as const) {
    const h = createHash('sha256');
    for await (const buf of createReadStream(files[field])) { stopped.signal.throwIfAborted(); h.update(buf); }
    if (h.digest('hex') !== VLM_FILE_HASHES[field]) throw new Error('4B 文件校验失败：' + field);
  }
  const port = await freePort();
  url = 'http://127.0.0.1:' + port;
  server = spawn(files.server, ['-m', files.model, '--mmproj', files.projector,
    '--host', '127.0.0.1', '--port', String(port), '--api-key', key,
    '-c', String(4096 * VLM_PARALLEL), '-np', String(VLM_PARALLEL), '-ngl', 'all',
    '--jinja', '--reasoning', 'off', '-b', '512', '-ub', '256', '--cache-ram', '0'],
  { windowsHide: true, cwd: path.dirname(files.server), stdio: ['ignore', 'pipe', 'pipe'] });
  send({ type: 'server', pid: server.pid });
  let spawnError: Error | undefined;
  server.on('error', e => { spawnError = e; });
  const log = (chunk: Buffer) => { logTail = (logTail + chunk.toString()).replaceAll(key, '[redacted]').slice(-4096); };
  server.stdout?.on('data', log); server.stderr?.on('data', log);
  const deadline = Date.now() + 120_000;
  for (;;) {
    stopped.signal.throwIfAborted();
    if (spawnError) throw spawnError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('llama.cpp 启动失败：' + logTail.slice(-600));
    try {
      const r = await fetch(url + '/health', { headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(1000)]) });
      if (r.ok) break;
    } catch { stopped.signal.throwIfAborted(); }
    if (Date.now() > deadline) throw new Error('llama.cpp 启动超时');
    await delay(200, undefined, { signal: stopped.signal });
  }
  // Older engines can silently ignore a misplaced schema. Verify actual constrained decoding.
  const probe = await completion({ messages: [{ role: 'user', content: 'Write a paragraph. Do not write JSON.' }],
    temperature: 0, max_tokens: 64, chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true,
      schema: { type: 'object', properties: { probe: { const: 'locked' } }, required: ['probe'], additionalProperties: false } } } });
  if (JSON.stringify(probe) !== '{"probe":"locked"}') throw new Error('推理引擎未执行 JSON Schema 约束');
}
async function classify(file: string, sha: string) {
  let png: Buffer;
  try {
    if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('图片超过 64 MiB，跳过自动分类');
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('文件内容已变化，等待重新扫描');
    png = await sharp(bytes, { limitInputPixels: 100_000_000 }).rotate().flatten({ background: '#fff' })
      .removeAlpha().toColourspace('srgb').resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png().toBuffer();
  } catch (error) { return { kind: 'uncertain', fileError: String(error).slice(0, 300) }; }
  const value = await completion({
    messages: [{ role: 'system', content: VLM_PROMPT }, { role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } },
      { type: 'text', text: '请分类这张图片。' },
    ] }], temperature: 0, seed: 20261018, max_tokens: 64, cache_prompt: false, chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'image_kind', strict: true, schema: VLM_SCHEMA } },
  });
  return { kind: parseVlmResponse(value) };
}
let initialized: Promise<void> | undefined;
let active = 0;
process.on('message', (m: any) => {
  if (m.type === 'shutdown') { void stop(); return; }
  if (m.type === 'init' && !initialized) {
    initialized = init(m.files);
    void initialized.then(() => send({ id: m.id }), error => send({ id: m.id, error: String(error).slice(0, 1000) }));
    return;
  }
  if (m.type !== 'classify' || !initialized || stopping || active >= VLM_PARALLEL) {
    send({ id: m.id, error: '图片分类未就绪或超过并发上限' }); return;
  }
  active++;
  void (async () => {
    try {
      await initialized;
      const value = await classify(m.file, m.sha256);
      send({ id: m.id, value });
    } catch (error) { send({ id: m.id, error: String(error).slice(0, 1000) }); }
    finally { active--; }
  })();
});
