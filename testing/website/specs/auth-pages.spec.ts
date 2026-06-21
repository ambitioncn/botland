import { expect, test } from '@playwright/test';
import { installMockWebSocket, mockBotlandApi, seedAuth } from './helpers';

const authenticatedPages = [
  { path: '/app.html', text: 'Messages' },
  { path: '/discover.html', text: 'Discover Agents' },
  { path: '/feed.html', text: 'Post' },
  { path: '/profile.html', text: 'Website Tester' },
  { path: '/settings.html', text: 'Settings' },
];

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
  await installMockWebSocket(page);
  await mockBotlandApi(page);
});

for (const item of authenticatedPages) {
  test(`${item.path} accepts seeded auth and does not redirect to login`, async ({ page }) => {
    await page.goto(item.path);
    await expect(page).not.toHaveURL(/login\.html/);
    await expect(page.locator('body')).toContainText(item.text);
  });
}

test('message send is blocked until WebSocket authentication completes', async ({ page }) => {
  await page.goto('/app.html');
  await page.locator('.contact-item').first().click();
  await page.locator('#l-input').fill('hello before auth');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('.send-btn').click();

  let sent = await page.evaluate(() => {
    const ws = (window as any).__botlandWebSockets[0];
    return ws.sent.map((frame: string) => JSON.parse(frame).type);
  });
  expect(sent).toContain('auth');
  expect(sent).not.toContain('message.send');

  await page.evaluate(() => {
    const ws = (window as any).__botlandWebSockets[0];
    ws.onmessage({ data: JSON.stringify({ type: 'connected' }) });
  });
  await page.locator('#l-input').fill('hello through authenticated socket');
  await page.locator('.send-btn').click();

  sent = await page.evaluate(() => {
    const ws = (window as any).__botlandWebSockets[0];
    return ws.sent.map((frame: string) => JSON.parse(frame).type);
  });
  expect(sent).toContain('message.send');
});

test('app redirects to login when opened without auth', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/app.html');

  await expect(page).toHaveURL(/login\.html\?return_to=app\.html&reason=missing_auth/);
  await expect(page.locator('body')).toContainText('Welcome back');
  await page.close();
});

test('expired refresh token redirects to login instead of leaving a broken app shell', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/login.html');
  await page.evaluate(() => {
    localStorage.setItem('botland_access_token', 'expired-access-token');
    localStorage.setItem('botland_refresh_token', 'expired-refresh-token');
    localStorage.setItem('botland_citizen_id', 'citizen_expired');
  });
  await installMockWebSocket(page);
  await page.route('https://api.botland.im/api/v1/friends', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'expired' } }),
    });
  });
  await page.route('https://api.botland.im/api/v1/groups', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'expired' } }),
    });
  });
  await page.route('https://api.botland.im/api/v1/auth/refresh', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'refresh expired' } }),
    });
  });

  await page.goto('/app.html');

  await expect(page).toHaveURL(/login\.html\?return_to=app\.html&reason=session_expired/);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('botland_access_token')))
    .toBeNull();
  await page.close();
});
