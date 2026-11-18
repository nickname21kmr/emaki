/**
 * GET /api/events：SSE（附录 #36）。可补发的事件带 `id: <启动 id>.<序号>`；断线重连时浏览器带 Last-Event-ID 回来
 * （手动重建连接时前端放在 ?lastEventId= 里），这里先补发漏掉的；补不上（后端重启过、漏得比保留的多）先推一条 resync，前端整体刷新。
 * 最后推一条 hello（这次启动的 id、现在最后一条的 id）。
 *
 * 两个入口共用（app.ts、access/lan.ts）：局域网入口不推 access 事件（配对请求、校验码只给本机页面），
 * 设备被撤销时立即断开它的连接（options.watch）。
 */
import type { ServerEvent } from '@emaki/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../core/events.ts';

export interface EventRouteOptions {
  /** 不推给这个入口的事件 */
  skip?: (event: ServerEvent) => boolean;
  /** 连接建立时调用（在请求的上下文里，能拿到 actor）：close() 立即断开这个连接。返回连接关掉时的清理函数 */
  watch?: (close: () => void) => () => void;
}

export function eventRoutes(app: FastifyInstance, bus: EventBus, options: EventRouteOptions = {}): void {
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const send = (event: ServerEvent, sseId?: string) => {
      if (options.skip?.(event)) return;
      res.write(`${sseId ? `id: ${sseId}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
    };
    const header = req.headers['last-event-id'];
    const query = (req.query as { lastEventId?: string } | undefined)?.lastEventId;
    const last = (typeof header === 'string' && header) || query;
    // 先订阅再补发：补发是同步写的，中间不会插进新事件
    const unsubscribe = bus.subscribe(send);
    if (last) {
      const replay = bus.since(last);
      if ('resync' in replay) send({ type: 'resync', reason: replay.resync });
      else for (const d of replay.events) send(d.event, d.sseId);
    }
    // 接着从哪要：浏览器的 Last-Event-ID 也跟着更新（只有 id 的事件块也会更新它）
    send({ type: 'hello', boot: bus.boot, lastId: bus.lastId }, `${bus.boot}.${bus.lastId}`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    let unwatch: (() => void) | undefined;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      unsubscribe();
      unwatch?.();
    };
    // 被入口要求断开（设备撤销了）：先停止推送再结束响应
    unwatch = options.watch?.(() => {
      cleanup();
      res.end();
    });
    req.raw.on('close', cleanup);
  });
}
