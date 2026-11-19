/**
 * 假手机（docs/mobile.md 2.9）：App 出来之前，用它在真实网络上走一遍「搜到电脑 → 请求 → 在电脑上批准 → 用凭证读写 → 撤销后被拒绝」，
 * 顺便验证防火墙和 mDNS 在家里的网络里通不通。它也是以后 Kotlin App 的参考实现：每一步都照 src/access/pairing.ts 文件头的协议。
 *
 * 用法（仓库根目录）：
 *   npx tsx apps/server/scripts/lan-client.ts discover                         搜局域网里的 Emaki（_emaki._tcp，5 秒）
 *   npx tsx apps/server/scripts/lan-client.ts pair 192.168.1.5:5175 [--name 名称]   请求连接，打印校验码，等电脑上批准
 *   npx tsx apps/server/scripts/lan-client.ts call GET /api/summary              用保存的凭证请求（只认保存的证书指纹）
 *   npx tsx apps/server/scripts/lan-client.ts call POST /api/commands/curation.setFavorite '{"ids":["1"],"value":true}'
 *   npx tsx apps/server/scripts/lan-client.ts events                             连 SSE，打印收到的事件（撤销时会被断开）
 *   npx tsx apps/server/scripts/lan-client.ts upload a.png b.jpg [--album 名] [--chunk 字节]   传图（docs/mobile.md 5.4）：
 *       先问电脑有没有（按 sha256），只传没有的；一段段 PUT，断了重跑同一条命令会从断点接着传
 * 选项：--state <文件>（保存的状态，默认 ./lan-client.json）；--host <地址:端口>（call、events 换一个地址连）
 *
 * 和 App 要做的一样的几件事：
 * - 证书：自签的，不走系统的证书校验；第一次连上时记下证书 DER 的 sha256（指纹），之后每个连接都先比对指纹、对上了才发请求
 *   （自己 tls.connect，握手完比对，再把这个连接交给 http 发请求，指纹不对时一个字节都不会发出去）；
 * - 配对：commit = sha256(nonceA) → 拿到电脑的 nonceB → 公开 nonceA → 自己算校验码给用户看 → 长轮询等批准；
 * - 凭证：之后每个请求带 Authorization: Bearer <token>；401 device_revoked 表示被电脑移除了，要重新请求。
 */
import { Bonjour } from 'bonjour-service';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import http from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { pairingCode } from '../src/access/pairing.ts';

interface State {
  /** 电脑的固定标识、名称 */
  serverId: string;
  serverName: string;
  /** 证书指纹（hex）：只认这一张 */
  fingerprint: string;
  /** 上次连上的地址（host:port）和电脑告诉过的其他地址 */
  host: string;
  addresses: string[];
  deviceId: string;
  token: string;
}

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) flags.set(a.slice(2), argv[++i] ?? '');
  else args.push(a);
}
const stateFile = flags.get('state') || './lan-client.json';

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function loadState(): State {
  if (!existsSync(stateFile)) fail(`没有保存的凭证（${stateFile}）：先 pair`);
  return JSON.parse(readFileSync(stateFile, 'utf8')) as State;
}

function splitHost(hostPort: string): { host: string; port: number } {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(hostPort);
  if (!m) fail(`地址要写成 主机:端口，例如 192.168.1.5:5175（收到 ${hostPort}）`);
  return { host: m[1]!, port: Number(m[2]) };
}

// ---------------------------------------------------------------- 认准证书的连接

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

/** 连上电脑的 https，返回证书指纹；给了 expected 时指纹对不上就断开、报错（这时还没发任何请求） */
function connect(host: string, port: number, expected: string | null): Promise<{ socket: tls.TLSSocket; fingerprint: Buffer }> {
  return new Promise((resolve, reject) => {
    // 自签证书：不走系统的证书校验，由下面比对指纹；SNI 不能是 IP
    const socket = tls.connect({ host, port, rejectUnauthorized: false, ...(isIP(host) ? {} : { servername: host }) });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      if (!cert?.raw) {
        socket.destroy();
        return reject(new Error('电脑没有给出证书'));
      }
      const fingerprint = sha256(cert.raw);
      if (expected && fingerprint.toString('hex') !== expected) {
        socket.destroy();
        return reject(new Error(`证书指纹不对：期望 ${expected}，收到 ${fingerprint.toString('hex')}。可能有人在中间，拒绝连接`));
      }
      socket.off('error', reject);
      resolve({ socket, fingerprint });
    });
  });
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/** 在认准了证书的连接上发一个请求 */
async function request(
  hostPort: string,
  fingerprint: string,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; stream?: (res: http.IncomingMessage) => void; bytes?: Buffer } = {},
): Promise<Response> {
  const { host, port } = splitHost(hostPort);
  const { socket } = await connect(host, port, fingerprint);
  const payload: string | Buffer | undefined =
    opts.bytes ?? (opts.body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(opts.body));
  const type = opts.bytes ? 'application/octet-stream' : 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        path,
        // 连接已经建好（并且比对过指纹）：直接用它
        createConnection: () => socket,
        headers: {
          host: hostPort,
          accept: 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(payload !== undefined ? { 'content-type': type, 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        if (opts.stream && res.statusCode === 200) {
          opts.stream(res);
          res.on('end', () => resolve({ status: 200, headers: res.headers, body: null }));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          if ((res.headers['content-type'] ?? '').includes('json'))
            try {
              body = JSON.parse(text);
            } catch {
              /* 原样给 */
            }
          socket.end();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const show = (v: unknown, max = 3000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n…（共 ${s.length} 个字符，后面省略）` : s;
};

// ---------------------------------------------------------------- 子命令

/** 搜局域网里的 Emaki（_emaki._tcp），5 秒 */
async function discover(): Promise<void> {
  const bonjour = new Bonjour({}, (err: Error) => console.error(`mDNS 出错：${err.message}`));
  const found = new Map<string, string>();
  console.log('在局域网里搜 _emaki._tcp（5 秒）…');
  const browser = bonjour.find({ type: 'emaki' }, (s) => {
    const txt = (s.txt ?? {}) as Record<string, string>;
    // 电脑按网卡分别广播，TXT 的 addr 就是手机所在这块网卡上电脑的地址（access/discovery.ts）
    const where = txt.addr ?? ((s.addresses ?? []).join(', ') || s.host);
    const line = `${txt.name ?? s.name}  id=${txt.id ?? '?'}  协议 v${txt.v ?? '?'}  地址 ${where}  端口 ${s.port}`;
    if (!found.has(s.fqdn)) console.log(`• ${line}`);
    found.set(s.fqdn, line);
  });
  await new Promise((r) => setTimeout(r, 5000));
  browser.stop();
  bonjour.destroy();
  if (!found.size) console.log('没搜到。路由器开了 AP 隔离、连的是访客 Wi-Fi、或者电脑的防火墙挡住了 mDNS 时会这样：直接用地址 pair。');
  else console.log(`共找到 ${found.size} 台`);
}

/** 请求连接：hello → commit → reveal → 打印校验码 → 长轮询等批准 → 保存 */
async function pair(hostPort: string): Promise<void> {
  const { host, port } = splitHost(hostPort);
  // 0. 连上，记下证书指纹（之后每个连接都只认它）
  const first = await connect(host, port, null);
  first.socket.end();
  const fp = first.fingerprint;
  const fpHex = fp.toString('hex');
  console.log(`证书指纹 ${fpHex}`);
  const hello = (await request(hostPort, fpHex, 'GET', '/api/v1/hello')).body as {
    app?: string;
    protocol: number;
    serverId: string;
    name: string;
    version: string;
    addresses: string[];
    pairing: boolean;
  };
  if (hello?.app !== 'emaki') fail('对方不是 Emaki');
  console.log(`电脑「${hello.name}」 id=${hello.serverId}  Emaki ${hello.version}  协议 v${hello.protocol}`);
  console.log(`电脑的地址 ${hello.addresses.join(', ') || '（没有）'}`);
  if (!hello.pairing) fail('电脑现在不接受新的请求');

  // 1. 提交 nonceA 的哈希
  const nonceA = randomBytes(32);
  const name = flags.get('name') || `假手机（${os.hostname()}）`;
  const started = await request(hostPort, fpHex, 'POST', '/api/v1/pair', {
    body: { name, model: 'lan-client', commit: sha256(nonceA).toString('hex') },
  });
  if (started.status !== 200) fail(`请求失败（${started.status}）：${show(started.body)}`);
  const { id, nonce } = started.body as { id: string; nonce: string; expiresAt: string };

  // 2. 看到电脑的 nonceB 之后才公开 nonceA
  const revealed = await request(hostPort, fpHex, 'POST', `/api/v1/pair/${id}/reveal`, { body: { nonce: nonceA.toString('hex') } });
  if (revealed.status !== 200) fail(`公开随机数失败（${revealed.status}）：${show(revealed.body)}`);

  // 3. 自己算校验码
  const code = pairingCode(fp, nonceA, Buffer.from(nonce, 'hex'));
  console.log(`\n校验码  ${code.slice(0, 3)} ${code.slice(3)}\n请在电脑上核对两边的数字一样，再点「批准」（5 分钟内有效）…\n`);

  // 4. 长轮询等批准
  for (;;) {
    const r = await request(hostPort, fpHex, 'GET', `/api/v1/pair/${id}?wait=25`);
    const s = r.body as { status: string; deviceId?: string; token?: string };
    if (r.status !== 200) fail(`查询请求状态失败（${r.status}）：${show(r.body)}`);
    if (s.status === 'pending') continue;
    if (s.status === 'rejected') fail('电脑上拒绝了这个请求');
    if (s.status === 'expired') fail('请求过期了，重新 pair');
    const state: State = {
      serverId: hello.serverId,
      serverName: hello.name,
      fingerprint: fpHex,
      host: hostPort,
      addresses: hello.addresses,
      deviceId: s.deviceId!,
      token: s.token!,
    };
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    console.log(`✓ 已批准：设备 id ${state.deviceId}，凭证存在 ${stateFile}`);
    return;
  }
}

/** 用保存的凭证请求 */
async function call(method: string, path: string, json?: string): Promise<void> {
  const st = loadState();
  const hostPort = flags.get('host') || st.host;
  let body: unknown;
  if (json !== undefined)
    try {
      body = JSON.parse(json);
    } catch {
      fail(`请求体不是 JSON：${json}`);
    }
  const r = await request(hostPort, st.fingerprint, method.toUpperCase(), path, { body, token: st.token });
  const meta = ['x-emaki-command', 'x-emaki-undo', 'x-emaki-changes']
    .map((h) => (r.headers[h] ? `${h}: ${String(r.headers[h])}` : ''))
    .filter(Boolean);
  console.log(`${method.toUpperCase()} ${path} → ${r.status}${meta.length ? `\n${meta.join('\n')}` : ''}`);
  console.log(show(r.body));
  const code = (r.body as { code?: string } | null)?.code;
  if (r.status === 401 && code === 'device_revoked') console.log('（这台设备已经被电脑移除，要重新 pair）');
  if (r.status >= 400) process.exitCode = 1;
}

/** 连 SSE，打印收到的事件；被电脑断开（比如撤销了这台设备）时退出 */
async function events(): Promise<void> {
  const st = loadState();
  const hostPort = flags.get('host') || st.host;
  console.log(`连接 ${hostPort} 的事件流…`);
  const r = await request(hostPort, st.fingerprint, 'GET', '/api/events', {
    token: st.token,
    stream: (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (data) console.log(`${new Date().toLocaleTimeString()}  ${data}`);
        }
      });
    },
  });
  if (r.status !== 200) fail(`连不上事件流（${r.status}）：${show(r.body)}`);
  console.log('事件连接被电脑断开了');
}

/**
 * 传图（docs/mobile.md 5.4）：App 的上传器照这个写。一批用同一个 batchId（这一次运行生成的）；
 * 先问 → 没有的 begin（传过的直接 done、传了一半的拿到断点）→ 一段段 PUT → complete
 */
async function upload(files: string[]): Promise<void> {
  const st = loadState();
  const hostPort = flags.get('host') || st.host;
  const chunk = Number(flags.get('chunk') || 4 * 1024 * 1024);
  const album = flags.get('album') || undefined;
  const req = (method: string, path: string, opts: { body?: unknown; bytes?: Buffer } = {}) =>
    request(hostPort, st.fingerprint, method, path, { ...opts, token: st.token });
  const items = files.map((f) => {
    const bytes = readFileSync(f);
    return { file: f, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), mtime: statSync(f).mtime.toISOString() };
  });
  const check = await req('POST', '/api/uploads/check', {
    body: { files: items.map((i) => ({ sha256: i.sha256, size: i.bytes.length })) },
  });
  if (check.status !== 200) fail(`问不了（${check.status}）：${show(check.body)}`);
  const have = new Map((check.body as { results: { sha256: string; imageId: string | null }[] }).results.map((r) => [r.sha256, r.imageId]));
  const batchId = crypto.randomUUID();
  let imported = 0;
  let existing = 0;
  for (const it of items) {
    const name = basename(it.file);
    if (have.get(it.sha256)) {
      console.log(`= ${name}：电脑上本来就有（图片 ${have.get(it.sha256)}），不传`);
      existing++;
      continue;
    }
    const begin = await req('POST', '/api/uploads', {
      body: { batchId, sha256: it.sha256, size: it.bytes.length, fileName: name, modifiedAt: it.mtime, ...(album ? { album } : {}) },
    });
    if (begin.status !== 200) fail(`${name}：begin ${begin.status} ${show(begin.body)}`);
    const b = begin.body as { uploadId: string; received: number; status: string; imageId: string | null };
    if (b.status !== 'receiving') {
      console.log(`= ${name}：这台设备传过（图片 ${b.imageId}）`);
      existing++;
      continue;
    }
    if (b.received) console.log(`… ${name}：从断点 ${b.received} 接着传`);
    for (let off = b.received; off < it.bytes.length; off += chunk) {
      const put = await req('PUT', `/api/uploads/${b.uploadId}?offset=${off}`, { bytes: it.bytes.subarray(off, off + chunk) });
      if (put.status !== 200) fail(`${name}：PUT ${put.status} ${show(put.body)}`);
    }
    const done = await req('POST', `/api/uploads/${b.uploadId}/complete`);
    if (done.status !== 200) fail(`${name}：complete ${done.status} ${show(done.body)}`);
    const d = done.body as { status: string; imageId: string };
    console.log(
      `${d.status === 'imported' ? '✓' : '='} ${name}：${d.status === 'imported' ? '已入库' : '电脑上本来就有'}（图片 ${d.imageId}）`,
    );
    if (d.status === 'imported') imported++;
    else existing++;
  }
  console.log(`已传 ${imported} 张，${existing} 张电脑上本来就有`);
}

const [cmd, ...rest] = args;
try {
  if (cmd === 'discover') await discover();
  else if (cmd === 'pair' && rest[0]) await pair(rest[0]);
  else if (cmd === 'call' && rest[0] && rest[1]) await call(rest[0], rest[1], rest[2]);
  else if (cmd === 'events') await events();
  else if (cmd === 'upload' && rest.length) await upload(rest);
  else {
    console.log(
      '用法：lan-client.ts discover | pair <主机:端口> [--name 名称] | call <GET|POST|PATCH|DELETE> <路径> [json] | events | upload <文件…> [--album 名] [--chunk 字节]',
    );
    console.log('选项：--state <文件>（默认 ./lan-client.json）、--host <主机:端口>');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
