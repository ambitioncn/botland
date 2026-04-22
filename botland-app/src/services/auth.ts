import { Platform } from 'react-native';
import api from './api';

const TOKEN_KEY = 'botland_access_token';
const REFRESH_KEY = 'botland_refresh_token';
const CITIZEN_KEY = 'botland_citizen_id';

const storage = {
  async set(key: string, value: string) {
    if (Platform.OS === 'web') {
      localStorage.setItem(key, value);
    } else {
      const SecureStore = await import('expo-secure-store');
      await SecureStore.setItemAsync(key, value);
    }
  },
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return localStorage.getItem(key);
    } else {
      const SecureStore = await import('expo-secure-store');
      return SecureStore.getItemAsync(key);
    }
  },
  async del(key: string) {
    if (Platform.OS === 'web') {
      localStorage.removeItem(key);
    } else {
      const SecureStore = await import('expo-secure-store');
      await SecureStore.deleteItemAsync(key);
    }
  },
};

// Simple JWT expiry check (decode payload, check exp)
function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(atob(parts[1]));
    if (!payload.exp) return false;
    // Consider expired if less than 60 seconds remaining
    return payload.exp * 1000 < Date.now() + 60000;
  } catch {
    return true;
  }
}

let refreshPromise: Promise<string | null> | null = null;

export const auth = {
  async saveTokens(accessToken: string, refreshToken: string, citizenId: string) {
    await storage.set(TOKEN_KEY, accessToken);
    await storage.set(REFRESH_KEY, refreshToken);
    await storage.set(CITIZEN_KEY, citizenId);
  },

  async getAccessToken(): Promise<string | null> {
    const token = await storage.get(TOKEN_KEY);
    if (!token) return null;

    // If token is not expired, return it
    if (!isTokenExpired(token)) return token;

    // Token expired, try to refresh (deduplicate concurrent calls)
    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          const refreshToken = await storage.get(REFRESH_KEY);
          if (!refreshToken) return null;
          const res = await api.refresh(refreshToken);
          await storage.set(TOKEN_KEY, res.access_token);
          if (res.refresh_token) await storage.set(REFRESH_KEY, res.refresh_token);
          return res.access_token;
        } catch {
          // Refresh failed, clear tokens
          await auth.clear();
          return null;
        } finally {
          refreshPromise = null;
        }
      })();
    }
    return refreshPromise;
  },

  async getCitizenId(): Promise<string | null> {
    return storage.get(CITIZEN_KEY);
  },

  async clear() {
    await storage.del(TOKEN_KEY);
    await storage.del(REFRESH_KEY);
    await storage.del(CITIZEN_KEY);
  },
};

export default auth;
