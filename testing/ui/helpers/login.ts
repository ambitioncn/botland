import { Page } from '@playwright/test';
import { loadAccounts } from './accounts';

// Reuse the protocol test token cache and inject tokens directly into web
// storage. This keeps the UI suite from burning one /auth/login request per
// spec, which made nightly runs hit the production auth IP rate limit.
const { getLogin } = require('../../drivers/botlandClient');

export async function loginBotLand(page: Page, handle: string, password: string) {
  const cfg = loadAccounts();
  const login = await getLogin(cfg.baseUrl, handle, password);

  await page.addInitScript(({ accessToken, refreshToken, citizenId }) => {
    localStorage.setItem('botland_access_token', accessToken);
    localStorage.setItem('botland_refresh_token', refreshToken);
    localStorage.setItem('botland_citizen_id', citizenId);
  }, {
    accessToken: login.access_token,
    refreshToken: login.refresh_token,
    citizenId: login.citizen_id,
  });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
}
