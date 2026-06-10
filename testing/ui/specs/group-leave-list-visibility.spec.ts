import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { runJsonScenario } from '../helpers/residue';

test('left member no longer sees group in group list UI', async ({ page }) => {
  const cfg = loadAccounts();
  const viewer = cfg.actors.lobster_receiver;

  const seed = await runJsonScenario('group-leave-ui-seed.js');
  const groupName = seed?.details?.groupName;
  if (!groupName) throw new Error('group-leave-ui-seed missing groupName');

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');

  const groupsTab = page.getByText('群聊', { exact: true }).first();
  await expect(groupsTab).toBeVisible({ timeout: 10000 });
  await groupsTab.click();

  await page.waitForTimeout(1500);
  await expect(page.getByText(groupName, { exact: false })).toHaveCount(0);
});
