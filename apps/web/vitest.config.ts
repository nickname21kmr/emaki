import path from 'node:path';
import { defineProject } from 'vitest/config';

// 前端只测纯函数（日期、章节表这类），不起浏览器环境
export default defineProject({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { name: 'web', environment: 'node', include: ['src/**/*.test.ts'] },
});
