import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    poolOptions: {
      vm: {
        execArgv: ['--max-old-space-size=8192'],
      },
    },
  },
});
