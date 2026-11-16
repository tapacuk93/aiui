// One headless Chromium at a time (the machine is shared); see harness.mjs.
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  outputDir: './.out/test-results',
  testMatch: /.*\.spec\.mjs/,
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 5000 },
  reporter: process.env.CI ? 'line' : [['list']],
  use: { browserName: 'chromium', headless: true, viewport: { width: 1280, height: 800 } },
});
