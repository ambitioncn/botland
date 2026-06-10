import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { runJsonScenario } from '../helpers/residue';

test('disbanded group detail returns cleanly to refreshed group list', async ({ page }) => {
  const cfg = loadAccounts();
  const viewer = cfg.actors.lobster_receiver;

  const seed = await runJsonScenario('group-disband-open-chat-seed.js');
  const groupId = seed?.details?.groupId;
  const groupName = seed?.details?.groupName;
  if (!groupId || !groupName) throw new Error('group-disband-open-chat-seed missing details');

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');

  const groupsTab = page.getByText('群聊', { exact: true }).first();
  await expect(groupsTab).toBeVisible({ timeout: 10000 });
  await groupsTab.click();

  await expect(page.getByText(groupName, { exact: false })).toBeVisible({ timeout: 10000 });
  await page.getByText(groupName, { exact: false }).click();
  await expect(page.getByText('群详情', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByText('群详情', { exact: true }).click();

  await runJsonScenario('group-disband-by-id.js', [groupId]);

  await page.reload();
  await page.waitForLoadState('networkidle');
  await groupsTab.click();
  await page.waitForTimeout(1500);

  await expect(page.getByText(groupName, { exact: false })).toHaveCount(0);
  await expect(page.getByText('选择一个对话开始聊天', { exact: false })).toBeVisible({ timeout: 10000 });
});
