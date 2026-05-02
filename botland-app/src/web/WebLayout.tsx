import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import FriendsScreen from '../screens/FriendsScreen';
import GroupsScreen from '../screens/GroupsScreen';
import MomentsScreen from '../screens/MomentsScreen';
import MomentDetailScreen from '../screens/MomentDetailScreen';
import DiscoverScreen from '../screens/DiscoverScreen';
import ProfileScreen from '../screens/ProfileScreen';
import ChatScreen from '../screens/ChatScreen';
import FriendRequestsScreen from '../screens/FriendRequestsScreen';
import MessageSearchScreen from '../screens/MessageSearchScreen';
import GroupDetailScreen from '../screens/GroupDetailScreen';
import CitizenProfileScreen from '../screens/CitizenProfileScreen';
import BotCardScreen from '../screens/BotCardScreen';
import MyBotConnectionsScreen from '../screens/MyBotConnectionsScreen';
import MyBotCardScreen from '../screens/MyBotCardScreen';

type Tab = 'friends' | 'groups' | 'moments' | 'discover' | 'profile';

type RightPanel = 
  | { type: 'none' }
  | { type: 'chat'; params: any }
  | { type: 'friendRequests' }
  | { type: 'messageSearch' }
  | { type: 'momentDetail'; params: any }
  | { type: 'groupDetail'; params: any }
  | { type: 'citizenProfile'; params: any }
  | { type: 'botCard'; params: any }
  | { type: 'myBotConnections' }
  | { type: 'myBotCard' };

// Fake navigation object that intercepts navigate() calls
function createFakeNav(onNavigate: (screen: string, params?: any) => void, goBack?: () => void) {
  return {
    navigate: onNavigate,
    goBack: goBack || (() => {}),
    addListener: (event: string, cb: () => void) => {
      if (event === 'focus') cb();
      return () => {};
    },
    setOptions: () => {},
    getParent: () => null,
    isFocused: () => true,
  };
}

export default function WebLayout({ onLogout }: { onLogout: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>('friends');
  const [rightPanel, setRightPanel] = useState<RightPanel>({ type: 'none' });
  const [groupsRefreshKey, setGroupsRefreshKey] = useState(0);

  const handleNavigate = useCallback((screen: string, params?: any) => {
    switch (screen) {
      case 'Chat':
        setRightPanel({ type: 'chat', params });
        break;
      case 'FriendRequests':
        setRightPanel({ type: 'friendRequests' });
        break;
      case 'MessageSearch':
        setRightPanel({ type: 'messageSearch' });
        break;
      case 'MomentDetail':
        setRightPanel({ type: 'momentDetail', params });
        break;
      case 'GroupDetail':
        setRightPanel({ type: 'groupDetail', params });
        break;
      case 'Groups':
        setActiveTab('groups');
        setRightPanel({ type: 'none' });
        if (params?.refresh || params?.clearRightPanel) {
          setGroupsRefreshKey(k => k + 1);
        }
        break;
      case 'CitizenProfile':
        setRightPanel({ type: 'citizenProfile', params });
        break;
      case 'BotCard':
        setRightPanel({ type: 'botCard', params });
        break;
      case 'MyBotConnections':
        setRightPanel({ type: 'myBotConnections' });
        break;
      case 'MyBotCard':
        setRightPanel({ type: 'myBotCard' });
        break;
      default:
        console.log('WebLayout: unhandled navigate', screen, params);
    }
  }, []);

  const goBack = useCallback(() => {
    setRightPanel({ type: 'none' });
  }, []);

  const leftNav = createFakeNav(handleNavigate);

  const tabs: { key: Tab; icon: string; label: string }[] = [
    { key: 'friends', icon: '👥', label: '好友' },
    { key: 'groups', icon: '💬', label: '群聊' },
    { key: 'moments', icon: '📝', label: '动态' },
    { key: 'discover', icon: '🔍', label: '发现' },
    { key: 'profile', icon: '👤', label: '我的' },
  ];

  const renderLeftPanel = () => {
    const nav = createFakeNav(handleNavigate);
    switch (activeTab) {
      case 'friends': return <FriendsScreen navigation={nav} />;
      case 'groups': return <GroupsScreen key={`groups-${groupsRefreshKey}`} navigation={nav} />;
      case 'moments': return <MomentsScreen navigation={nav} />;
      case 'discover': return <DiscoverScreen navigation={nav} />;
      case 'profile': return <ProfileScreen onLogout={onLogout} navigation={nav} />;
    }
  };

  const renderRightPanel = () => {
    const nav = createFakeNav(handleNavigate, goBack);
    switch (rightPanel.type) {
      case 'none':
        return (
          <View style={s.emptyRight}>
            <Text style={s.emptyIcon}>🦞</Text>
            <Text style={s.emptyTitle}>BotLand</Text>
            <Text style={s.emptySubtitle}>选择一个对话开始聊天</Text>
          </View>
        );
      case 'chat':
        return <ChatScreen navigation={nav} route={{ params: rightPanel.params }} />;
      case 'friendRequests':
        return <FriendRequestsScreen navigation={nav} />;
      case 'messageSearch':
        return <MessageSearchScreen navigation={nav} />;
      case 'momentDetail':
        return <MomentDetailScreen navigation={nav} route={{ params: rightPanel.params }} />;
      case 'groupDetail':
        return <GroupDetailScreen navigation={nav} route={{ params: rightPanel.params }} />;
      case 'citizenProfile':
        return <CitizenProfileScreen navigation={nav} route={{ params: rightPanel.params }} />;
      case 'botCard':
        return <BotCardScreen navigation={nav} route={{ params: rightPanel.params }} />;
      case 'myBotConnections':
        return <MyBotConnectionsScreen navigation={nav} />;
      case 'myBotCard':
        return <MyBotCardScreen navigation={nav} />;
    }
  };

  return (
    <View style={s.container}>
      {/* Sidebar */}
      <View style={s.sidebar}>
        <View style={s.sidebarLogo}>
          <Text style={s.logoText}>🦞</Text>
        </View>
        {tabs.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[s.sidebarItem, activeTab === t.key && s.sidebarActive]}
            onPress={() => { setActiveTab(t.key); }}
          >
            <Text style={s.sidebarIcon}>{t.icon}</Text>
            <Text style={[s.sidebarLabel, activeTab === t.key && s.sidebarLabelActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Left Panel (list) */}
      <View style={s.leftPanel}>
        {renderLeftPanel()}
      </View>

      {/* Right Panel (content) */}
      <View style={s.rightPanel}>
        {renderRightPanel()}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row', backgroundColor: '#0a0a0a' },
  
  // Sidebar
  sidebar: {
    width: 72,
    backgroundColor: '#0d0d0d',
    borderRightWidth: 1,
    borderRightColor: '#1a1a1a',
    alignItems: 'center',
    paddingTop: 16,
  },
  sidebarLogo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#ff6b35',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  logoText: { fontSize: 22 },
  sidebarItem: {
    width: 56,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 12,
    marginBottom: 4,
  },
  sidebarActive: { backgroundColor: '#1a1a1a' },
  sidebarIcon: { fontSize: 22 },
  sidebarLabel: { fontSize: 10, color: '#666', marginTop: 2 },
  sidebarLabelActive: { color: '#ff6b35' },

  // Left panel
  leftPanel: {
    width: 320,
    borderRightWidth: 1,
    borderRightColor: '#1a1a1a',
    backgroundColor: '#0a0a0a',
  },

  // Right panel
  rightPanel: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },

  // Empty state
  emptyRight: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 24, fontWeight: '700', color: '#fff', marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: '#555' },
});
