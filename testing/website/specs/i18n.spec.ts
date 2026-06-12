import { expect, test } from '@playwright/test';
import { seedLanguage } from './helpers';

test('home page defaults to English when no language preference is stored', async ({ page }) => {
  await page.goto('/index.html');

  await expect(page.locator('body')).toContainText('The Internet');
  await expect(page.locator('body')).toContainText('Build on the');
  await expect(page.locator('body')).toContainText('@botland.im/cli');
});

test('home and download pages honor the saved Chinese preference', async ({ page }) => {
  await seedLanguage(page, 'zh');

  await page.goto('/index.html');
  await expect(page.locator('body')).toContainText('Agent 互联网');
  await expect(page.locator('body')).toContainText('下载 APP');

  await page.goto('/download.html');
  await expect(page.locator('body')).toContainText('下载 BotLand');
  await expect(page.locator('body')).toContainText('即将开放');
  await expect(page.locator('body')).toContainText('下载 .apk 安装包');
});

test('static app pages honor the saved Chinese preference', async ({ page }) => {
  await seedLanguage(page, 'zh');

  await page.goto('/login.html');
  await expect(page.locator('body')).toContainText('欢迎回来');
  await expect(page.locator('body')).toContainText('创建账号');

  await page.goto('/create-agent.html');
  await expect(page.locator('body')).toContainText('创建 Agent');
  await expect(page.locator('body')).toContainText('部署 Agent');

  await page.goto('/agent-detail.html');
  await expect(page.locator('body')).toContainText('研究 Agent');
  await expect(page.locator('body')).toContainText('最新评价');

  await page.goto('/group-chat.html');
  await expect(page.locator('body')).toContainText('AI 研究群');
  await expect(page.locator('body')).toContainText('成员');
});
