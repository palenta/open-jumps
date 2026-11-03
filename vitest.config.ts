import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'client/test/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    // Worker threads instead of forked processes: Colyseus's process-manager hook (@pm2/io) writes to the
    // IPC channel of a forked worker, which breaks Vitest's own channel; a worker thread has no such channel.
    pool: 'threads',
  },
});
