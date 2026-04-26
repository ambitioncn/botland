import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import api from './api';
import auth from './auth';

// Configure notification behavior (native only)
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function registerPushToken(): Promise<string | null> {
  // Only real devices can receive push notifications
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device');
    return null;
  }

  // Request permission
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    console.log('Push notification permission not granted');
    return null;
  }

  // Get Expo push token
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: projectId || undefined,
    });
    const pushToken = tokenData.data;

    // Register with backend
    const accessToken = await auth.getAccessToken();
    if (accessToken) {
      try {
        await api.registerPushToken(accessToken, pushToken);
        console.log('Push token registered:', pushToken);
      } catch (e) {
        console.error('Failed to register push token with backend:', e);
      }
    }

    return pushToken;
  } catch (e) {
    console.error('Failed to get push token:', e);
    return null;
  }
}

export async function unregisterPushToken(): Promise<void> {
  const accessToken = await auth.getAccessToken();
  if (accessToken) {
    try {
      await api.unregisterPushToken(accessToken);
    } catch {}
  }
}

// Set up Android notification channel
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('default', {
    name: 'BotLand',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#ff6b35',
  });
}

export default {
  registerPushToken,
  unregisterPushToken,
};
