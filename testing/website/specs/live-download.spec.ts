import { expect, test } from '@playwright/test';

test.skip(process.env.BOTLAND_WEBSITE_LIVE !== '1', 'Set BOTLAND_WEBSITE_LIVE=1 to hit production www.botland.im.');

test('production Android APK is reachable and keeps the expected deployed size', async ({ request }) => {
  const res = await request.head('https://www.botland.im/botland.apk');
  expect(res.ok()).toBeTruthy();
  const contentLength = Number(res.headers()['content-length'] || 0);
  expect(contentLength).toBeGreaterThan(75 * 1024 * 1024);
});
