'use strict';
/**
 * 插件服务端逻辑的子进程（docs/plugins.md 第 6 节，宿主在 ./host.ts）。普通的 CommonJS，不经 tsx：
 * 子进程带着权限参数启动（只能读插件的包和这个文件，只能写插件自己的数据目录），加载器读不了别处的文件。
 *
 * 宿主先发 init，这里加载插件的入口（import()），调用它导出的 activate(emaki)。插件拿到的 emaki：
 * - call(命令或查询, 输入)：经宿主调注册表，受插件的授权限制，记成 plugin:<id>@<版本>；
 * - fetch(url, 选项)：经宿主联网（走 Emaki 的代理设置），只能连清单里声明、授权给了的域名；也可以直接用 Node 的 fetch；
 * - storage（键值，和插件的视图共用）、settings（你在插件详情里填的）、secrets（凭证，视图读不到）、files（能写的文件夹）；
 * - library.import：把 files 里下载好的图放进授权里给的文件夹（去重、入库、识别都走现有的路）；
 * - commands.handle：实现清单里登记的命令；jobs.register / jobs.start：后台任务（进现有的任务列表，进度、取消都一样）；
 * - on('changed', fn)：图库变了以后旁观（拦不下来）；log：写进 Emaki 的日志。
 *
 * 和宿主之间的消息（IPC，advanced 序列化，Uint8Array 原样传）：
 *   宿主 → 这里：init、command、job、cancel、event、reply、shutdown
 *   这里 → 宿主：ready、result、progress、jobDone、req、sub、log、fatal
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const send = (m) => {
  if (process.connected) process.send(m);
};

let seq = 0;
const pending = new Map();
function request(op, args) {
  return new Promise((resolve, reject) => {
    const rid = ++seq;
    pending.set(rid, { resolve, reject });
    send({ t: 'req', rid, op, args });
  });
}

const commands = new Map();
const jobs = new Map();
const running = new Map();
const listeners = new Map();
let mod = null;

const errorText = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));

function makeEmaki(init) {
  const full = (name) => (name.startsWith(`${init.id}.`) ? name : `${init.id}.${name}`);
  const filesDir = init.dataDir;
  return Object.freeze({
    plugin: Object.freeze({ id: init.id, version: init.version, name: init.name }),
    call: (name, input = {}) => request('call', { name, input }),
    fetch: (url, options = {}) => request('fetch', { url: String(url), ...options }),
    storage: Object.freeze({
      get: (key) => request('storage.get', { key }),
      set: (key, value) => request('storage.set', { key, value }),
      delete: (key) => request('storage.delete', { key }),
      list: (prefix = '') => request('storage.list', { prefix }),
    }),
    settings: Object.freeze({ get: (id) => request('settings.get', { key: id }) }),
    secrets: Object.freeze({
      get: (key) => request('secrets.get', { key }),
      set: (key, value) => request('secrets.set', { key, value }),
      delete: (key) => request('secrets.set', { key, value: null }),
    }),
    files: Object.freeze({
      dir: filesDir,
      /** 数据目录里的一个路径（不能往上跳出去） */
      path: (...parts) => {
        const p = path.resolve(filesDir, ...parts);
        if (p !== filesDir && !p.startsWith(filesDir + path.sep)) throw new Error('路径要在插件自己的文件夹里');
        return p;
      },
    }),
    library: Object.freeze({
      /** files: [{ path（数据目录里的，相对或绝对）, fileName? }]；folder：清单 permissions.folders 里的 id（不写用第一个） */
      import: (o) => request('library.import', o),
    }),
    commands: Object.freeze({
      handle: (name, fn) => {
        if (typeof fn !== 'function') throw new Error('commands.handle 要给一个函数');
        commands.set(full(name), fn);
      },
    }),
    jobs: Object.freeze({
      register: (kind, fn) => {
        if (typeof fn !== 'function') throw new Error('jobs.register 要给一个函数');
        jobs.set(kind, fn);
      },
      /** 排一个后台任务；返回 { id }。title 不写用清单里的 label */
      start: (kind, input = {}, o = {}) => request('jobs.start', { kind, input, title: o.title }),
    }),
    on: (type, fn) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
        send({ t: 'sub', type });
      }
      set.add(fn);
      return () => set.delete(fn);
    },
    log: (...args) =>
      send({
        t: 'log',
        text: args
          .map((a) => (typeof a === 'string' ? a : safeJson(a)))
          .join(' ')
          .slice(0, 2000),
      }),
  });
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function init(m) {
  const emaki = makeEmaki(m);
  mod = await import(pathToFileURL(m.entry).href);
  const activate =
    typeof mod.activate === 'function' ? mod.activate : typeof mod.default === 'function' ? mod.default : mod.default?.activate;
  if (typeof activate !== 'function') throw new Error('入口要导出 activate(emaki)');
  await activate(emaki);
  send({ t: 'ready', commands: [...commands.keys()], jobs: [...jobs.keys()] });
}

async function runCommand(m) {
  try {
    const fn = commands.get(m.name);
    if (!fn) throw new Error(`插件没有实现命令 ${m.name}（commands.handle）`);
    const value = await fn(m.input ?? {}, { caller: m.caller });
    send({ t: 'result', rid: m.rid, ok: true, value: value === undefined ? null : value });
  } catch (e) {
    send({ t: 'result', rid: m.rid, ok: false, error: errorText(e) });
  }
}

async function runJob(m) {
  const controller = new AbortController();
  running.set(m.jobId, controller);
  try {
    const fn = jobs.get(m.kind);
    if (!fn) throw new Error(`插件没有实现任务 ${m.kind}（jobs.register）`);
    const ctx = Object.freeze({
      id: m.jobId,
      signal: controller.signal,
      setTotal: (total) => send({ t: 'progress', jobId: m.jobId, total: total == null ? null : Number(total) }),
      advance: (n = 1, message) => send({ t: 'progress', jobId: m.jobId, advance: Number(n) || 0, message }),
      setMessage: (message) => send({ t: 'progress', jobId: m.jobId, message: String(message) }),
    });
    const value = await fn(m.input ?? {}, ctx);
    send({ t: 'jobDone', jobId: m.jobId, ok: true, value: typeof value === 'string' ? value : null });
  } catch (e) {
    send({ t: 'jobDone', jobId: m.jobId, ok: false, error: errorText(e), cancelled: controller.signal.aborted });
  } finally {
    running.delete(m.jobId);
  }
}

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'init':
      init(m).catch((e) => {
        send({ t: 'fatal', message: `启动失败：${errorText(e)}` });
        setImmediate(() => process.exit(1));
      });
      break;
    case 'reply': {
      const p = pending.get(m.rid);
      if (!p) break;
      pending.delete(m.rid);
      if (m.ok) p.resolve(m.value);
      else p.reject(Object.assign(new Error(m.error), m.code ? { code: m.code } : {}));
      break;
    }
    case 'command':
      void runCommand(m);
      break;
    case 'job':
      void runJob(m);
      break;
    case 'cancel':
      running.get(m.jobId)?.abort();
      break;
    case 'event':
      for (const fn of listeners.get(m.type) ?? []) {
        Promise.resolve()
          .then(() => fn(m.data))
          .catch((e) => send({ t: 'log', text: `处理 ${m.type} 出错：${errorText(e)}` }));
      }
      break;
    case 'shutdown':
      Promise.resolve()
        .then(() => (typeof mod?.deactivate === 'function' ? mod.deactivate() : undefined))
        .catch(() => {})
        .finally(() => process.exit(0));
      break;
  }
});

// 没接住的错误：告诉宿主原因再退出（宿主记一次错误、按退避时间重启）
const fatal = (e) => {
  send({ t: 'fatal', message: errorText(e) });
  setImmediate(() => process.exit(1));
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
// 宿主没了（IPC 断开）就跟着退出
process.on('disconnect', () => process.exit(0));
