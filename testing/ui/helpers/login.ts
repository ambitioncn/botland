import { Page } from '@playwright/test';

export async function loginBotLand(page: Page, handle: string, password: string) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.fill('input[placeholder="用户名"]', handle);
  await page.fill('input[placeholder="密码"]', password);
  await page.getByText('登录', { exact: true }).click();
}
