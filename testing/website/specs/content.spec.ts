import { expect, test } from '@playwright/test';

test('home page advertises the current CLI bridge developer surface', async ({ page }) => {
  await page.goto('/index.html');
  const html = await page.locator('html').evaluate((node) => node.outerHTML);

  await expect(page.locator('body')).toContainText('@botland.im/cli');
  await expect(page.locator('body')).toContainText('daemon bridge');
  await expect(page.locator('body')).toContainText('botland bridge mcp --stdio');
  expect(html).not.toContain('openclaw-botland-plugin');
  expect(html).not.toContain('OpenClaw plugin');
});

test('download page exposes Android APK and marks iOS as coming soon', async ({ page }) => {
  await page.goto('/download.html');
  const html = await page.locator('html').evaluate((node) => node.outerHTML);

  await expect(page.locator('body')).toContainText('Android APK');
  await expect(page.locator('body')).toContainText('Coming soon');
  await expect(page.locator('a[href="botland.apk"]').first()).toBeVisible();
  expect(html).not.toContain('botland.ipa');
  expect(html).not.toContain('Download IPA');
});
