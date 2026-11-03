// Playwright for the browser smoke route (plan 2.9, matrix row 19): one phone-sized Chromium, one worker, the
// real server built and started on 127.0.0.1:2610 serving the built client (same origin: API, static files
// and the WebSocket on one host, as production). Run with `npx playwright test -c client/e2e/playwright.config.ts`
// after `npx playwright install chromium` (a browser download — done together with the owner). Not part of
// `npm test` (Vitest only collects client/test/**/*.test.ts).
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/** The monorepo root (this file lives in client/e2e/). */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const BASE_URL = 'http://127.0.0.1:2610';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    ...devices['iPhone 13 landscape'],
  },
  projects: [
    {
      name: 'phone',
      use: {
        // The device descriptor defaults to WebKit; the smoke route runs in Chromium (the one browser installed).
        browserName: 'chromium',
        // An iPhone 16e in landscape as the layout tests measure it (CSS px of the available viewport).
        viewport: { width: 844, height: 390 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command:
      'npm run build && ADMIN_KEY=e2e ALLOWED_ORIGINS=http://127.0.0.1:2610 PORT=2610 HOST=127.0.0.1 SECURE_COOKIES=false DB_PATH=./data/e2e.sqlite STATIC_DIR=client/dist npx tsx server/src/index.ts',
    cwd: repoRoot,
    // GET / is the built index page (200); /api/me answers 401 before sign-in, so it cannot be the readiness probe.
    url: `${BASE_URL}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
