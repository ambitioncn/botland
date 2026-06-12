import { expect, test } from '@playwright/test';
import { installMockWebSocket, mockBotlandApi, mockBotlandAuth } from './helpers';

test.beforeEach(async ({ page }) => {
  await installMockWebSocket(page);
  await mockBotlandApi(page);
  await mockBotlandAuth(page);
});

test('sign in stores returned auth state and enters the app', async ({ page }) => {
  await page.goto('/login.html');

  await page.locator('#signin-handle').fill('website_login');
  await page.locator('#signin-password').fill('correct horse battery staple');
  await page.locator('#l-btn-signin').click();

  await expect(page).toHaveURL(/app\.html/);
  await expect(page.locator('body')).toContainText('Messages');

  const authState = await page.evaluate(() => ({
    access: localStorage.getItem('botland_access_token'),
    refresh: localStorage.getItem('botland_refresh_token'),
    citizenId: localStorage.getItem('botland_citizen_id'),
    handle: localStorage.getItem('botland_handle'),
    type: localStorage.getItem('botland_citizen_type'),
  }));
  expect(authState).toEqual({
    access: 'login-access-token',
    refresh: 'login-refresh-token',
    citizenId: 'citizen_login_user',
    handle: 'website_login',
    type: 'human',
  });
});

test('sign up solves the human challenge before registration', async ({ page }) => {
  const requests: Array<{ path: string; body: any }> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname === 'api.botland.im' && url.pathname.startsWith('/api/v1/auth/')) {
      requests.push({ path: url.pathname, body: request.postDataJSON() });
    }
  });

  await page.goto('/login.html');
  await page.locator('#tab-signup').click();
  await page.locator('#signup-handle').fill('@fresh_citizen');
  await page.locator('#signup-display').fill('Fresh Citizen');
  await page.locator('#signup-password').fill('correct horse battery staple');
  await page.locator('#l-btn-signup').click();

  await expect(page).toHaveURL(/app\.html/);

  const paths = requests.map((request) => request.path);
  expect(paths).toEqual([
    '/api/v1/auth/challenge',
    '/api/v1/auth/challenge/answer',
    '/api/v1/auth/register',
  ]);
  expect(requests[2].body).toMatchObject({
    handle: 'fresh_citizen',
    display_name: 'Fresh Citizen',
    challenge_token: 'challenge-token-website',
    species: 'human',
  });
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('botland_access_token'))).toBe('register-access-token');
});
