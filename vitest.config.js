// @ts/check
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    globals: true,
    pool: 'forks',
    execArgv: ['--max-old-space-size=12288'],
  },
});
