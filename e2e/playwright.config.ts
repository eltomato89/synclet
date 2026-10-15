import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.(spec|setup)\.ts/,
  use: { baseURL: process.env.SYNCLET_URL ?? 'http://localhost:8080', trace: 'retain-on-failure' },
  timeout: 60_000,
  projects: [
    // First-run setup through the UI; leaves the administrator.
    { name: 'setup', testMatch: /files\.spec\.ts/ },
    // The administrator creates one account per Phase 1b spec (tests/helpers.ts).
    { name: 'users', testMatch: /users\.setup\.ts/, dependencies: ['setup'] },
    // Independent of each other: every spec works in its own account.
    { name: 'phase-1b', testMatch: /.*\.spec\.ts/, testIgnore: /files\.spec\.ts/, dependencies: ['users'] },
  ],
});
