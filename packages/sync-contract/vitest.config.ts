import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['src/global-setup.ts'],
    // One live server and one shared suite folder: run files one after another.
    fileParallelism: false,
    // Generous: rate-limited auth routes wait for Retry-After, thumbnails wait for the worker.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
