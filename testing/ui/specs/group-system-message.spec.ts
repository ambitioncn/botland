import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { runJsonScenario } from '../helpers/residue';

test('group system message appears in group chat UI', async ({ page }) => {
  const cfg = loadAccounts();
  const viewer = cfg.actors.lobster_sender;

  const seed = await runJsonScenario('group-system-message-seed.js');
  const groupName = seed?.details?.groupName;
  const systemText = seed?.details?.systemText;
  const actorName = seed?.details?.actorName;
  if (!groupName || !systemText) throw new Error('group-system-message-seed missing required details');

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');

  const groupsTab = page.getByText('群聊', { exact: true }).first();
  await expect(groupsTab).toBeVisible({ timeout: 10000 });
  await groupsTab.click();

  await expect(page.getByText(groupName, { exact: false })).toBeVisible({ timeout: 10000 });
  await page.getByText(groupName, { exact: false }).click();

  await expect(page.getByText(systemText, { exact: false })).toBeVisible({ timeout: 10000 });
  if (actorName) {
    await expect(page.getByText(actorName, { exact: false })).toBeVisible({ timeout: 10000 });
  }
});
