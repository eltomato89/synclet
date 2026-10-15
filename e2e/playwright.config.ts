import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: process.env.SYNCLET_URL ?? 'http://localhost:8080', trace: 'retain-on-failure' },
  timeout: 60_000,
  projects: [
    // Runs the first-run setup through the UI and leaves the administrator the other specs use.
    { name: 'setup', testMatch: /files\.spec\.ts/ },
    // Each spec signs up its own user (tests/helpers.ts), so they are independent of each other.
    { name: 'phase-1b', testIgnore: /files\.spec\.ts/, dependencies: ['setup'] },
  ],
});
