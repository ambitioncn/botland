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
