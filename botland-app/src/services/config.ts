import Constants from 'expo-constants';

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

const DEFAULT_API_BASE_URL = 'https://api.botland.im';

type ExtraConfig = {
  botlandApiBaseUrl?: string;
  botlandWsUrl?: string;
};

const extra = (Constants.expoConfig?.extra || {}) as ExtraConfig;
const env = typeof process !== 'undefined' ? process.env || {} : {};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function toWsUrl(httpUrl: string): string {
  return trimTrailingSlash(httpUrl).replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/ws';
}

export const API_BASE_URL = trimTrailingSlash(
  env.EXPO_PUBLIC_BOTLAND_API_URL || extra.botlandApiBaseUrl || DEFAULT_API_BASE_URL
);

export const WS_URL = trimTrailingSlash(
  env.EXPO_PUBLIC_BOTLAND_WS_URL || extra.botlandWsUrl || toWsUrl(API_BASE_URL)
);

export const appConfig = {
  apiBaseUrl: API_BASE_URL,
  wsUrl: WS_URL,
};
