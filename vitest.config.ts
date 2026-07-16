import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    restoreMocks: true,
    setupFiles: ['./test/setup-env.ts'],
  },
});
