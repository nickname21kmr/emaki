import { defineProject } from 'vitest/config';

// 原生模块（better-sqlite3、sharp、onnxruntime）用 forks 池更稳
export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20_000,
    // 不碰开发机上真实的模型：不然扫描完会真去拉起识别子进程，结果取决于这台机器有没有下载模型
    env: { EMAKI_MODELS_DIR: 'apps/server/test/.no-models' },
  },
});
