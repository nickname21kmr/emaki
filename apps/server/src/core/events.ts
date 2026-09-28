import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@emaki/shared';

/**
 * 进程内事件总线。数据层 / 后台任务往这里 emit，
 * `routes/events.ts` 把它转成 SSE 推给前端。
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 每个打开的浏览器标签页是一个订阅者
    this.emitter.setMaxListeners(100);
  }

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
