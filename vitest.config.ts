import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { projects: ['packages/shared', 'apps/server', 'apps/web'] },
});
