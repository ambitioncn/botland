import { expect, test } from '@playwright/test';
import { installMockWebSocket } from './helpers';

test('BotLandAPI authenticates WebSocket with a frame instead of a query token', async ({ page }) => {
  await installMockWebSocket(page);
  await page.goto('/download.html');
  await page.addScriptTag({ path: '../../botland-website/botland-api.js' });

  const stateEvents = await page.evaluate(async () => {
    localStorage.setItem('botland_access_token', 'test-access-token');
    const states: string[] = [];
    (window as any).BotLandAPI.connectWebSocket(null, (state: string) => states.push(state));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return states;
  });

  const wsSnapshot = await page.evaluate(() => {
    const ws = (window as any).__botlandWebSockets[0];
    return { url: ws.url, sent: ws.sent, authenticated: ws.botlandAuthenticated };
  });

  expect(stateEvents).toContain('authenticating');
  expect(wsSnapshot.url).toBe('wss://api.botland.im/ws');
  expect(wsSnapshot.url).not.toContain('token=');
  expect(JSON.parse(wsSnapshot.sent[0])).toEqual({ type: 'auth', token: 'test-access-token' });
  expect(wsSnapshot.authenticated).toBe(false);

  const connected = await page.evaluate(() => {
    const ws = (window as any).__botlandWebSockets[0];
    ws.onmessage({ data: JSON.stringify({ type: 'connected' }) });
    return ws.botlandAuthenticated;
  });
  expect(connected).toBe(true);
});
