import { defineProject } from 'vitest/config';

// 原生模块（better-sqlite3、sharp、onnxruntime）用 forks 池更稳
export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20_000,
  },
});
