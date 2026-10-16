import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.(spec|setup)\.ts/,
  use: { baseURL: process.env.SYNCLET_URL ?? 'http://localhost:8080', trace: 'retain-on-failure' },
  timeout: 60_000,
  projects: [
    // First-run setup through the UI; leaves the administrator.
    { name: 'setup', testMatch: /files\.spec\.ts/ },
    // The administrator creates one account per spec (tests/helpers.ts).
    { name: 'users', testMatch: /users\.setup\.ts/, dependencies: ['setup'] },
    // Independent of each other: every spec works in its own account.
    { name: 'specs', testMatch: /.*\.spec\.ts/, testIgnore: /(files|admin|sso)\.spec\.ts/, dependencies: ['users'] },
    // Server-wide state (users, sessions, sign-in settings): after everything else, one at a time.
    { name: 'admin', testMatch: /admin\.spec\.ts/, dependencies: ['specs'] },
    { name: 'sso', testMatch: /sso\.spec\.ts/, dependencies: ['admin'] },
  ],
});
