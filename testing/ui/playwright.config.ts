import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  // CI seeds groups through the live API before opening the UI. Production
  // rate-limit retries can legitimately make setup exceed Playwright's
  // 30s default even when the UI behavior is healthy.
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: 'npx expo start --web',
    cwd: '../../botland-app',
    url: 'http://127.0.0.1:8081',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:8081',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
