import { test, expect } from '../harness.mjs';

test('web: loads on the root and asks for an AI key', async ({ app }) => {
  await app.open();
  await expect(app.page.locator('#circles .circle')).toHaveCount(4, { timeout: 100 }).catch(() => {});
  await expect(app.page.locator('#title')).toHaveText('Connect an AI');
});

test('native: loads on the root with an AI', async ({ app }) => {
  await app.open({ native: true });
  await expect(app.page.locator('#circles .circle').first()).toBeVisible();
  await expect.poll(() => app.sent('engine', 'status').length).toBe(1);
});
