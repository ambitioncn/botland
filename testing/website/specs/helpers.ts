import { Page } from '@playwright/test';

export async function seedAuth(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('botland_access_token', 'test-access-token');
    localStorage.setItem('botland_refresh_token', 'test-refresh-token');
    localStorage.setItem('botland_citizen_id', 'citizen_test_owner');
    localStorage.setItem('botland_handle', 'website_tester');
    localStorage.setItem('botland_citizen_type', 'human');
  });
}

export async function seedLanguage(page: Page, lang: 'en' | 'zh') {
  await page.addInitScript((value) => {
    localStorage.setItem('bl_lang', value);
  }, lang);
}

export async function mockBotlandAuth(page: Page) {
  await page.route('https://api.botland.im/api/v1/auth/challenge', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: 'challenge_session_website',
        questions: [
          { id: 'q_smell', text: 'What did you smell this morning?' },
          { id: 'q_meal', text: 'What was your last meal?' },
        ],
      }),
    });
  });
  await page.route('https://api.botland.im/api/v1/auth/challenge/answer', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ token: 'challenge-token-website' }),
    });
  });
  await page.route('https://api.botland.im/api/v1/auth/login', async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'login-access-token',
        refresh_token: 'login-refresh-token',
        citizen_id: 'citizen_login_user',
        handle: body.handle,
        citizen_type: 'human',
      }),
    });
  });
  await page.route('https://api.botland.im/api/v1/auth/register', async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'register-access-token',
        refresh_token: 'register-refresh-token',
        citizen_id: 'citizen_registered_user',
        handle: body.handle,
        citizen_type: 'human',
      }),
    });
  });
}

export async function mockBotlandApi(page: Page) {
  await page.route('https://api.botland.im/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/me') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          citizen_id: 'citizen_test_owner',
          handle: 'website_tester',
          display_name: 'Website Tester',
          citizen_type: 'human',
        }),
      });
      return;
    }
    if (path === '/api/v1/friends') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          friends: [
            {
              citizen_id: 'citizen_peer_agent',
              handle: 'peer_agent',
              display_name: 'Peer Agent',
              citizen_type: 'agent',
              is_online: true,
              description: 'Mocked website test peer',
            },
          ],
        }),
      });
      return;
    }
    if (path === '/api/v1/groups') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
      return;
    }
    if (path === '/api/v1/discover/search') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) });
      return;
    }
    if (path === '/api/v1/moments/timeline') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ moments: [] }) });
      return;
    }
    if (path === '/api/v1/messages/history') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

export async function installMockWebSocket(page: Page) {
  await page.addInitScript(() => {
    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      url: string;
      readyState = MockWebSocket.CONNECTING;
      sent: string[] = [];
      onopen: null | (() => void) = null;
      onclose: null | (() => void) = null;
      onerror: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;

      constructor(url: string) {
        this.url = url;
        (window as any).__botlandWebSockets = (window as any).__botlandWebSockets || [];
        (window as any).__botlandWebSockets.push(this);
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.();
        }, 0);
      }

      send(data: string) {
        this.sent.push(data);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    (window as any).WebSocket = MockWebSocket;
  });
}
