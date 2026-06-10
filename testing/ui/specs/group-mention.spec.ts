import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { runJsonScenario } from '../helpers/residue';

test('group mention text appears in group chat UI', async ({ page }) => {
  const cfg = loadAccounts();
  const viewer = cfg.actors.lobster_receiver;

  const seed = await runJsonScenario('group-mention-seed.js');

  const groupName = seed?.details?.groupName;
  const mentionDisplay = seed?.details?.mentionDisplay;
  const messageText = seed?.details?.messageText;
  if (!groupName || !mentionDisplay || !messageText) throw new Error('seed scenario missing required details');

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');
  await page.getByText('群聊', { exact: true }).click();
  await expect(page.getByText(groupName, { exact: false })).toBeVisible({ timeout: 10000 });
  await page.getByText(groupName, { exact: false }).click();

  await expect(page.getByText(`@${mentionDisplay}`, { exact: false })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(messageText, { exact: false })).toBeVisible({ timeout: 10000 });
});
