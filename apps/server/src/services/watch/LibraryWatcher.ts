/**
 * 文件监听：图库里有新增 / 删除 / 改名 / 修改时，几秒内触发一次增量扫描（只扫受影响的目录）。
 *
 * 用 Node 自带的 fs.watch(root, { recursive: true })，不用 chokidar：Windows 上基于 ReadDirectoryChangesW，
 * 每个根目录只要 1 个句柄；chokidar 会给每个文件建一个 watcher（10 万张图 = 10 万个句柄）。
 * 监听器只负责「标脏 + 防抖 + 入队」，真假判断交给扫描器。
 */
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isImageFile, isoFromMs, isSkippedDirName, parentRel, pathKey, toAbs } from '../fs/paths.ts';
import type { ScanRequests } from '../scan/ScanRequests.ts';

export interface WatchedRoot {
  id: number;
  path: string;
  enabled: boolean;
}

export class LibraryWatcher {
  private readonly watchers = new Map<number, FSWatcher>();
  /** 需要 stat 才知道是不是目录的路径（目录新增、改名、删除） */
  private readonly unknown = new Map<string, { rootId: number; rel: string }>();
  /** 图片的 change 事件：flush 时比对大小和修改时间，没变就不扫 */
  private readonly touched = new Map<string, { rootId: number; rel: string }>();
  private roots: WatchedRoot[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private firstEventAt = 0;
  private readonly reachTimer: NodeJS.Timeout;
  private readonly rescanTimer: NodeJS.Timeout | null = null;
  private readonly dataKey: string;

  constructor(
    private readonly d: {
      requests: ScanRequests;
      /** () => jobs.enqueue('scan', { requeueIfRunning: true }) */
      enqueueScan: () => void;
      dataDir: string;
      log: (msg: string, err?: unknown) => void;
      /** 安静这么久才触发，默认 1500 */
      quietMs?: number;
      /** 持续有事件时最多等这么久，默认 10000 */
      maxWaitMs?: number;
      /** 定时兜底全量扫描的间隔（分钟），0 = 关闭 */
      rescanMinutes?: number;
      /** 可达性检查间隔，默认 60 秒 */
      reachMs?: number;
      /**
       * 库里记录的大小和修改时间。给了它，图片的 change 事件只有在大小或修改时间真的变了才标脏——
       * 备份 / 同步软件、杀毒、索引器经常只改文件属性，不过滤的话会每隔几秒触发一次扫描，把识别任务一直打断
       */
      known?: (rootId: number, rel: string) => { bytes: number; modified_at: string } | undefined;
    },
  ) {
    this.dataKey = pathKey(d.dataDir);
    // 可达性重试：U 盘插回来自动补扫；根目录被改名 / 移走时关掉旧 watcher
    this.reachTimer = setInterval(() => void this.checkReachability(), d.reachMs ?? 60_000);
    this.reachTimer.unref();
    const minutes = d.rescanMinutes ?? Number(process.env.EMAKI_RESCAN_MINUTES ?? 180);
    if (minutes > 0) {
      // 弥补漏掉的事件（缓冲区溢出、网络盘）
      this.rescanTimer = setInterval(() => {
        this.d.requests.requestFull();
        this.d.enqueueScan();
      }, minutes * 60_000);
      this.rescanTimer.unref();
    }
  }

  /** 启动或关闭各个根的 watcher，使之与「启用且未移除」的根一致 */
  sync(roots: WatchedRoot[]): void {
    this.roots = roots.filter((r) => r.enabled);
    const want = new Set(this.roots.map((r) => r.id));
    for (const [id, w] of this.watchers) {
      // 根被停用或移除：一定要关，否则 U 盘「无法安全弹出」
      if (!want.has(id)) {
        w.close();
        this.watchers.delete(id);
      }
    }
    for (const r of this.roots) if (!this.watchers.has(r.id)) this.start(r);
  }

  async close(): Promise<void> {
    clearInterval(this.reachTimer);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private start(root: WatchedRoot): void {
    let w: FSWatcher;
    try {
      // persistent: false —— 进程由 HTTP 服务保活，watcher 不要阻止退出
      w = watch(toAbs(root.path, ''), { recursive: true, persistent: false }, (event, filename) => this.onEvent(root, filename, event));
    } catch (err) {
      this.d.log(`无法监听 ${root.path}`, err); // 根目录不存在：交给可达性重试
      return;
    }
    // 必须挂 error 监听：Windows 上被监听的目录被删除会报 EPERM，没有监听器进程直接崩溃
    w.on('error', (err) => {
      this.d.log(`监听中断 ${root.path}`, err);
      w.close();
      this.watchers.delete(root.id);
      this.d.requests.addDirty({ rootId: root.id, relDir: '', recursive: true });
      this.schedule();
    });
    this.watchers.set(root.id, w);
  }

  private onEvent(root: WatchedRoot, filename: string | Buffer | null, event: string = 'rename'): void {
    if (!filename) {
      // 文件名为 null（例如缓冲区溢出）→ 整个根增量重扫
      this.d.requests.addDirty({ rootId: root.id, relDir: '', recursive: true });
      return this.schedule();
    }
    const rel = String(filename).split(path.sep).join('/');
    const segs = rel.split('/');
    if (segs.slice(0, -1).some(isSkippedDirName)) return; // .git、$RECYCLE.BIN 里的变化不管
    if (pathKey(toAbs(root.path, rel)).startsWith(this.dataKey + '/')) return;
    if (isImageFile(segs.at(-1)!)) {
      if (event === 'change' && this.d.known) this.touched.set(`${root.id}
${rel}`, { rootId: root.id, rel });
      else this.d.requests.addDirty({ rootId: root.id, relDir: parentRel(rel), recursive: false });
    } else if (event === 'rename') {
      // 可能是目录被新增、改名或删除，flush 时再 stat。
      // 目录的 change 事件不管：Windows 在目录里新建文件时也会给目录本身发 change，那种情况上面的图片事件已经覆盖了
      this.unknown.set(`${root.id}\n${rel}`, { rootId: root.id, rel });
    }
    this.schedule();
  }

  private schedule(): void {
    const now = Date.now();
    if (!this.debounceTimer) this.firstEventAt = now;
    else clearTimeout(this.debounceTimer);
    const wait = Math.min(this.d.quietMs ?? 1500, Math.max(0, this.firstEventAt + (this.d.maxWaitMs ?? 10_000) - now));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    const items = [...this.unknown.values()];
    this.unknown.clear();
    for (const { rootId, rel } of items) {
      const root = this.roots.find((r) => r.id === rootId);
      if (!root) continue;
      try {
        const st = await stat(toAbs(root.path, rel));
        if (st.isDirectory()) this.d.requests.addDirty({ rootId, relDir: rel, recursive: true });
        // 普通非图片文件：忽略
      } catch {
        // 被删除或被改名走：扫描器会发现这个前缀下的行都不在了
        this.d.requests.addDirty({ rootId, relDir: rel, recursive: true });
      }
    }
    const touched = [...this.touched.values()];
    this.touched.clear();
    for (const { rootId, rel } of touched) {
      const root = this.roots.find((r) => r.id === rootId);
      if (!root) continue;
      const row = this.d.known?.(rootId, rel);
      const st = row && (await stat(toAbs(root.path, rel)).catch(() => null));
      if (row && st && st.size === row.bytes && isoFromMs(st.mtimeMs) === row.modified_at) continue; // 只改了属性
      this.d.requests.addDirty({ rootId, relDir: parentRel(rel), recursive: false });
    }
    if (this.d.requests.pending) this.d.enqueueScan();
  }

  private async checkReachability(): Promise<void> {
    for (const r of this.roots) {
      const ok = await stat(r.path).then((s) => s.isDirectory(), () => false);
      const w = this.watchers.get(r.id);
      if (!w && ok) {
        this.start(r);
        this.d.requests.addDirty({ rootId: r.id, relDir: '', recursive: true });
        this.d.enqueueScan();
      } else if (w && !ok) {
        // Windows 上句柄会跟着被改名的目录走，不报错也不再对应原路径 → 关掉，路径恢复后重新 start
        w.close();
        this.watchers.delete(r.id);
      }
    }
  }
}
