import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'shared', include: ['src/**/*.test.ts'] } });
