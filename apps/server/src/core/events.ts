import { EventEmitter } from 'node:events';
import type { ReplayableEvent, ServerEvent } from '@emaki/shared';
import { BOOT_ID } from './boot.ts';

/** 断线重连时最多补发这么多条（只算可补发的事件：领域变化、命令、自动改动） */
export const REPLAY_KEEP = 500;

/** 推出去的事件：可补发的带着 SSE 的 id（`<启动 id>.<序号>`） */
export interface Delivered {
  event: ServerEvent;
  /** SSE 的 id 行；进度这类不补发的事件没有 */
  sseId?: string;
}

/** 补发的结果：events 是断线期间漏掉的；resync 表示补不上（后端重启过、或者漏掉的太多），前端整体刷新 */
export type Replay = { events: Delivered[] } | { resync: 'restarted' | 'gap' };

/**
 * 进程内事件总线（附录 #36）。数据层 / 后台任务往这里推，`GET /api/events` 把它转成 SSE 推给前端。
 *
 * - emit：进度这类只管「现在」的事件（job、job-item），不编号、不补发；
 * - publish：领域变化、命令、自动改动这些「漏了就不对」的事件：编上递增的序号（事件里的 id），记在最近 REPLAY_KEEP 条里，
 *   SSE 带上 `id: <启动 id>.<序号>`。断线重连时浏览器带着 Last-Event-ID 回来，从这里补发；补不上时让前端整体刷新。
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private seq = 0;
  private readonly kept: Delivered[] = [];

  constructor(readonly boot: string = BOOT_ID) {
    // 每个打开的浏览器标签页是一个订阅者
    this.emitter.setMaxListeners(100);
  }

  /** 最后一条可补发事件的序号（还没有是 0） */
  get lastId(): number {
    return this.seq;
  }

  /** 不补发的事件（任务进度等） */
  emit(event: ServerEvent): void {
    this.emitter.emit('event', { event } satisfies Delivered);
  }

  /** 可补发的事件：编号、记下、推出去。返回序号 */
  publish(event: ReplayableEvent): number {
    const id = ++this.seq;
    const delivered: Delivered = { event: { ...event, id } as ServerEvent, sseId: `${this.boot}.${id}` };
    this.kept.push(delivered);
    if (this.kept.length > REPLAY_KEEP) this.kept.splice(0, this.kept.length - REPLAY_KEEP);
    this.emitter.emit('event', delivered);
    return id;
  }

  subscribe(listener: (event: ServerEvent, sseId?: string) => void): () => void {
    const fn = (d: Delivered) => listener(d.event, d.sseId);
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  /** 按 Last-Event-ID 补发：同一次启动、还在保留范围里的补上，否则让前端整体刷新 */
  since(lastEventId: string): Replay {
    const m = /^([\w-]+)\.(\d+)$/.exec(lastEventId.trim());
    if (!m || m[1] !== this.boot) return { resync: 'restarted' };
    const last = Number(m[2]);
    if (last >= this.seq) return { events: [] };
    const oldest = this.kept[0];
    const oldestId = oldest ? Number(oldest.sseId!.split('.')[1]) : this.seq + 1;
    // 最早留着的那条之前还有漏掉的：补不全
    if (last + 1 < oldestId) return { resync: 'gap' };
    return { events: this.kept.filter((d) => Number(d.sseId!.split('.')[1]) > last) };
  }
}
