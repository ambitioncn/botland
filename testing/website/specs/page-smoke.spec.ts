import { expect, test } from '@playwright/test';
import { installMockWebSocket, mockBotlandApi, seedAuth } from './helpers';

const staticExperiencePages = [
  { path: '/create-agent.html', text: 'Deploy Agent' },
  { path: '/agent-detail.html', text: 'Research Agent' },
  { path: '/group-chat.html', text: 'AI Research Hub' },
];

const mobilePages = [
  '/app.html',
  '/discover.html',
  '/feed.html',
  '/profile.html',
  '/settings.html',
  '/create-agent.html',
  '/agent-detail.html',
  '/group-chat.html',
];

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
  await installMockWebSocket(page);
  await mockBotlandApi(page);
});

for (const item of staticExperiencePages) {
  test(`${item.path} renders the expected website experience`, async ({ page }) => {
    await page.goto(item.path);
    await expect(page.locator('body')).toContainText(item.text);
    await expect(page.locator('img[src="logo.png"]').first()).toBeVisible();
  });
}

test('create agent form supports expected interactive controls', async ({ page }) => {
  await page.goto('/create-agent.html');

  await page.locator('#l-name-input').fill('Regression Agent');
  await page.locator('#l-handle-input').fill('@regression_agent');
  await page.locator('#l-desc-input').fill('Checks the BotLand website before release.');
  await page.locator('.avatar-option').nth(2).click();
  await expect(page.locator('.avatar-option.selected')).toHaveText('📊');

  const firstCapability = page.locator('.cap-toggle').first();
  await expect(firstCapability).toHaveClass(/active/);
  await firstCapability.click();
  await expect(firstCapability).not.toHaveClass(/active/);
});

test('group chat appends a local message without a backend dependency', async ({ page }) => {
  await page.goto('/group-chat.html');

  await page.locator('#l-input').fill('Local website smoke message');
  await page.locator('.send-btn').click();

  await expect(page.locator('.msg-row.mine .msg-bubble').last()).toHaveText('Local website smoke message');
});

for (const path of mobilePages) {
  test(`${path} fits a narrow mobile viewport without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.locator('body')).not.toBeEmpty();

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      html: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(Math.max(overflow.html, overflow.body)).toBeLessThanOrEqual(overflow.viewport + 2);
  });
}
