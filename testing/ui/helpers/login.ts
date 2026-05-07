import { Page } from '@playwright/test';

export async function loginBotLand(page: Page, handle: string, password: string, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.fill('input[placeholder="用户名"]', handle);
    await page.fill('input[placeholder="密码"]', password);
    await page.getByText('登录', { exact: true }).click();
    // Wait for either login success (sidebar appears) or rate-limit error
    const rateLimit = page.getByText('too many requests', { exact: false });
    const sidebar = page.getByText('好友', { exact: true });
    try {
      await Promise.race([
        sidebar.waitFor({ timeout: 10000 }),
        rateLimit.waitFor({ timeout: 10000 }),
      ]);
    } catch {}
    // If sidebar visible, login succeeded
    if (await sidebar.isVisible({ timeout: 500 }).catch(() => false)) return;
    // If rate limit and retries left, wait and retry
    if (i < retries && await rateLimit.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.waitForTimeout(3000);
      continue;
    }
    // Last attempt or unexpected state — let the test proceed and fail naturally
    break;
  }
}
