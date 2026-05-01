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

test('group typing indicator appears in group chat UI', async ({ page }) => {
  const cfg = loadAccounts();
  const viewer = cfg.actors.lobster_receiver;

  const seed = await runJsonScenario('group-create-only.js');
  const groupName = seed?.details?.groupName;
  const groupId = seed?.details?.groupId;
  const senderName = seed?.details?.senderName || '忘了鸭';
  if (!groupName || !groupId) throw new Error('group-create-only missing group details');

  await loginBotLand(page, viewer.handle, viewer.password);
  await page.waitForLoadState('networkidle');

  const groupsTab = page.getByText('群聊', { exact: true }).first();
  await expect(groupsTab).toBeVisible({ timeout: 10000 });
  await groupsTab.click();

  await expect(page.getByText(groupName, { exact: false })).toBeVisible({ timeout: 10000 });
  await page.getByText(groupName, { exact: false }).click();
  await expect(page.getByPlaceholder('输入消息...')).toBeVisible({ timeout: 10000 });

  const typingPromise = runJsonScenario('group-trigger-typing.js', [groupId]);
  await expect(page.getByLabel('typing-indicator')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(new RegExp(`${senderName}.*正在输入|正在输入`, 'i'))).toBeVisible({ timeout: 10000 });
  await typingPromise;
});
