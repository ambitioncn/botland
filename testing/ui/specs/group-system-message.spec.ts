import { test, expect } from '@playwright/test';
import { loadAccounts } from '../helpers/accounts';
import { loginBotLand } from '../helpers/login';
import { spawn } from 'child_process';
import path from 'path';

function runJsonScenario(scriptName: string, args: string[] = []) {
  const scenarioPath = path.resolve(process.cwd(), `../scenarios/${scriptName}`);
  return new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [scenarioPath, ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${scriptName} failed: ${stderr || code}`));
      try {
        resolve(JSON.parse(stdout.trim().split(/\n(?=\{)/).pop() || '{}'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

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
