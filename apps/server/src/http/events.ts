/**
 * GET /api/events：SSE（附录 #36）。可补发的事件带 `id: <启动 id>.<序号>`；断线重连时浏览器带 Last-Event-ID 回来
 * （手动重建连接时前端放在 ?lastEventId= 里），这里先补发漏掉的；补不上（后端重启过、漏得比保留的多）先推一条 resync，前端整体刷新。
 * 最后推一条 hello（这次启动的 id、现在最后一条的 id）。
 */
import type { ServerEvent } from '@emaki/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../core/events.ts';

export function eventRoutes(app: FastifyInstance, bus: EventBus): void {
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

    const send = (event: ServerEvent, sseId?: string) => res.write(`${sseId ? `id: ${sseId}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
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
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
