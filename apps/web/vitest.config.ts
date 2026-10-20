import path from 'node:path';
import { defineProject } from 'vitest/config';

// 纯函数及组件静态渲染，不起浏览器环境。
export default defineProject({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { name: 'web', environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
