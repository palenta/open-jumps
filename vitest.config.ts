import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
