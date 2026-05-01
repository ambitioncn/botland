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
