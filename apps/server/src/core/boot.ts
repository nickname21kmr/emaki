import { randomUUID } from 'node:crypto';

/**
 * 这次启动的 id。撤销栈只在内存里：前端看到它变了就丢掉旧的撤销记录（/api/health 的 bootId）；
 * SSE 的事件 id 也带着它，重启之后带旧 id 重连的，补发不了，让前端整体刷新（core/events.ts）
 */
export const BOOT_ID = randomUUID();
