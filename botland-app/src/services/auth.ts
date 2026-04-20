import { Platform } from 'react-native';

const TOKEN_KEY = 'botland_access_token';
const REFRESH_KEY = 'botland_refresh_token';
const CITIZEN_KEY = 'botland_citizen_id';

// Web fallback using localStorage
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

export const auth = {
  async saveTokens(accessToken: string, refreshToken: string, citizenId: string) {
    await storage.set(TOKEN_KEY, accessToken);
    await storage.set(REFRESH_KEY, refreshToken);
    await storage.set(CITIZEN_KEY, citizenId);
  },

  async getAccessToken(): Promise<string | null> {
    return storage.get(TOKEN_KEY);
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
