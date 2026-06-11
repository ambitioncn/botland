import React, { useEffect, useState, useRef } from 'react';
import { View, Text, AppState, Platform } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';

import LoginScreen from './src/screens/LoginScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import FriendsScreen from './src/screens/FriendsScreen';
import FriendRequestsScreen from './src/screens/FriendRequestsScreen';
import ChatScreen from './src/screens/ChatScreen';
import DiscoverScreen from './src/screens/DiscoverScreen';
import MomentsScreen from './src/screens/MomentsScreen';
import MomentDetailScreen from './src/screens/MomentDetailScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import GroupsScreen from './src/screens/GroupsScreen';
import GroupDetailScreen from './src/screens/GroupDetailScreen';
import CitizenProfileScreen from './src/screens/CitizenProfileScreen';
import MessageSearchScreen from './src/screens/MessageSearchScreen';
import WebLayout from './src/web/WebLayout';
import auth from './src/services/auth';
import { registerPushToken } from './src/services/notifications';
import wsManager from './src/services/wsManager';
import { t } from './src/i18n';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const DarkTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: '#0a0a0a', card: '#111', text: '#fff', border: '#222', primary: '#ff6b35' },
};

function TabIcon({ label }: { label: string }) {
  const icons: Record<string, string> = { Friends: '👥', Groups: '💬', Moments: '📝', Discover: '🔍', Profile: '👤' };
  return <Text style={{ fontSize: 20 }}>{icons[label] || '•'}</Text>;
}

function MainTabs({ onLogout }: { onLogout: () => void }) {
  return (
    <Tab.Navigator screenOptions={({ route }) => ({
      tabBarStyle: { backgroundColor: '#111', borderTopColor: '#222' },
      tabBarActiveTintColor: '#ff6b35',
      tabBarInactiveTintColor: '#555',
      headerStyle: { backgroundColor: '#111' },
      headerTintColor: '#fff',
      tabBarIcon: () => <TabIcon label={route.name} />,
    })}>
      <Tab.Screen name="Friends" component={FriendsScreen} options={{ title: t('nav.friends') }} />
      <Tab.Screen name="Moments" component={MomentsScreen} options={{ title: t('nav.moments') }} />
      <Tab.Screen name="Groups" component={GroupsScreen} options={{ title: t('nav.groups') }} />
      <Tab.Screen name="Discover" component={DiscoverScreen} options={{ title: t('nav.discover') }} />
      <Tab.Screen name="Profile" options={{ title: t('nav.profile') }}>
        {() => <ProfileScreen onLogout={onLogout} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const navigationRef = useRef<any>(null);

  useEffect(() => {
    auth.getAccessToken().then((t) => setLoggedIn(!!t));
  }, []);

  // Global WebSocket lifecycle — connect on login, disconnect on logout
  useEffect(() => {
    if (loggedIn) {
      wsManager.connect();
    } else if (loggedIn === false) {
      wsManager.disconnect();
    }
  }, [loggedIn]);

  // Reconnect when app comes back to foreground (mobile)
  useEffect(() => {
    if (!loggedIn) return;

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        // App foregrounded — ensure WS is alive
        wsManager.connect();
      }
      // Note: we do NOT disconnect on background — push notifications
      // handle offline delivery. The server's pongWait will eventually
      // clean up stale connections.
    });

    return () => subscription.remove();
  }, [loggedIn]);

  // Register push token after login
  useEffect(() => {
    if (loggedIn && Platform.OS !== 'web') {
      registerPushToken().catch(console.error);
    }
  }, [loggedIn]);

  // Handle notification tap (navigate to chat)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      if (data?.type === 'message' && data?.from_id && navigationRef.current) {
        navigationRef.current.navigate('Chat', {
          friendId: data.from_id,
          friendName: response.notification.request.content.title || t('nav.chat'),
        });
      }
      if (data?.type === 'group_message' && data?.group_id && navigationRef.current) {
        navigationRef.current.navigate('Chat', {
          groupId: data.group_id,
          groupName: response.notification.request.content.title || t('nav.groups'),
          chatType: 'group',
        });
      }
    });
    return () => subscription.remove();
  }, []);

  if (loggedIn === null) return <View style={{ flex: 1, backgroundColor: '#0a0a0a' }} />;

  const handleLogout = () => {
    wsManager.disconnect();
    auth.clear();
    setLoggedIn(false);
  };

  return (
    <NavigationContainer theme={DarkTheme} ref={navigationRef}>
      <StatusBar style="light" />
      {loggedIn ? (
        Platform.OS === 'web' ? (
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="WebMain">
              {() => <WebLayout onLogout={handleLogout} />}
            </Stack.Screen>
          </Stack.Navigator>
        ) : (
          <Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: '#111' }, headerTintColor: '#fff' }}>
            <Stack.Screen name="Main" options={{ headerShown: false }}>
              {() => <MainTabs onLogout={handleLogout} />}
            </Stack.Screen>
            <Stack.Screen name="Chat" component={ChatScreen} options={({ route }: any) => ({ title: route.params?.friendName || t('nav.chat') })} />
            <Stack.Screen name="FriendRequests" component={FriendRequestsScreen} options={{ title: t('nav.friendRequests') }} />
            <Stack.Screen name="MomentDetail" component={MomentDetailScreen} options={{ title: t('nav.momentDetail') }} />
            <Stack.Screen name="GroupDetail" component={GroupDetailScreen} options={{ title: t('nav.groupDetail') }} />
            <Stack.Screen name="CitizenProfile" component={CitizenProfileScreen} options={{ title: t('nav.citizenProfile') }} />
            <Stack.Screen name="MessageSearch" component={MessageSearchScreen} options={{ title: t('nav.messageSearch') }} />
          </Stack.Navigator>
        )
      ) : (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Login">
            {(props) => <LoginScreen {...props} onLogin={() => setLoggedIn(true)} />}
          </Stack.Screen>
          <Stack.Screen name="Register">
            {(props) => <RegisterScreen {...props} onLogin={() => setLoggedIn(true)} />}
          </Stack.Screen>
        </Stack.Navigator>
      )}
    </NavigationContainer>
  );
}
