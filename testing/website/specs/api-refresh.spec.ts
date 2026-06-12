import { expect, test } from '@playwright/test';

test('BotLandAPI refreshes an expired access token and retries once', async ({ page }) => {
  const authHeaders: string[] = [];
  const refreshBodies: unknown[] = [];
  let meCalls = 0;

  await page.route('https://api.botland.im/api/v1/me', async (route) => {
    meCalls += 1;
    authHeaders.push(route.request().headers().authorization || '');
    if (meCalls === 1) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'expired' } }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ citizen_id: 'citizen_test_owner', handle: 'website_tester' }),
    });
  });

  await page.route('https://api.botland.im/api/v1/auth/refresh', async (route) => {
    refreshBodies.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'fresh-access-token',
        refresh_token: 'fresh-refresh-token',
        citizen_id: 'citizen_test_owner',
      }),
    });
  });

  await page.goto('/download.html');
  await page.addScriptTag({ path: '../../botland-website/botland-api.js' });
  const result = await page.evaluate(async () => {
    localStorage.setItem('botland_access_token', 'expired-access-token');
    localStorage.setItem('botland_refresh_token', 'refresh-token');
    return (window as any).BotLandAPI.me();
  });

  expect(result).toMatchObject({ citizen_id: 'citizen_test_owner' });
  expect(meCalls).toBe(2);
  expect(refreshBodies).toEqual([{ refresh_token: 'refresh-token' }]);
  expect(authHeaders).toEqual(['Bearer expired-access-token', 'Bearer fresh-access-token']);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('botland_access_token'))).toBe('fresh-access-token');
});
