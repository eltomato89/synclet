import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: process.env.SYNCLET_URL ?? 'http://localhost:8080', trace: 'retain-on-failure' },
  timeout: 60_000,
});
