import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, Alert } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';
import wsManager from '../services/wsManager';

type Friend = { citizen_id: string; display_name: string; species?: string; my_label?: string; is_online?: boolean };
type Props = { navigation: any };

export default function FriendsScreen({ navigation }: Props) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const loadData = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const [friendsRes, requestsRes] = await Promise.all([
        api.getFriends(token),
        api.getFriendRequests(token, 'incoming'),
      ]);
      setFriends((friendsRes.friends || []) as Friend[]);
      setPendingCount(requestsRes.total || 0);
    } catch {}
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Real-time presence updates
  useEffect(() => {
    const unsub = wsManager.onMessage((data) => {
      if (data.type === 'presence.changed' && data.payload?.citizen_id) {
        const cid = data.payload.citizen_id;
        const online = data.payload.state === 'online';
        setFriends(prev => prev.map(f => f.citizen_id === cid ? { ...f, is_online: online } : f));
      }
    });
    return () => unsub();
  }, []);

  // Reload when navigating back to this screen
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      loadData();
    });
    return unsubscribe;
  }, [navigation, loadData]);

  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const handleRemoveFriend = async (friendId: string, friendName: string) => {
    const doRemove = async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try {
        await api.removeFriend(token, friendId);
        loadData();
      } catch (e: any) {
        const msg = e?.message || '操作失败';
        if (typeof window !== 'undefined') window.alert(msg);
      }
    };

    if (typeof window !== 'undefined') {
      if (window.confirm(`确定要解除与 ${friendName} 的好友关系吗？`)) {
        await doRemove();
      }
    } else {
      Alert.alert('解除好友', `确定要解除与 ${friendName} 的好友关系吗？`, [
        { text: '取消', style: 'cancel' },
        { text: '确定解除', style: 'destructive', onPress: doRemove },
      ]);
    }
  };

  const renderItem = ({ item }: { item: Friend }) => (
    <View style={s.item}>
      <TouchableOpacity style={s.itemMain} onPress={() => navigation.navigate('Chat', { friendId: item.citizen_id, friendName: item.display_name })}>
        <View style={s.avatarWrap}>
          <View style={s.avatar}><Text style={s.avatarText}>{item.display_name?.[0] || '?'}</Text></View>
          {item.is_online && <View style={s.onlineDot} />}
        </View>
        <View style={s.info}>
          <Text style={s.name}>{item.display_name}</Text>
          {item.my_label ? <Text style={s.label}>{item.my_label}</Text> : null}
          {item.species ? <Text style={s.species}>{item.species}</Text> : null}
        </View>
        <Text style={s.arrow}>›</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.removeBtn} onPress={() => handleRemoveFriend(item.citizen_id, item.display_name)}>
        <Text style={s.removeX}>✕</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={s.container}>
      {/* Message Search */}
      <TouchableOpacity
        style={s.searchBanner}
        onPress={() => navigation.navigate('MessageSearch')}
      >
        <Text style={s.searchIcon}>🔍</Text>
        <Text style={s.searchLabel}>搜索聊天记录</Text>
        <Text style={s.arrow}>›</Text>
      </TouchableOpacity>

      {/* Friend Requests Banner */}
      <TouchableOpacity
        style={s.requestBanner}
        onPress={() => navigation.navigate('FriendRequests')}
      >
        <View style={s.requestIconWrap}>
          <Text style={s.requestIcon}>📬</Text>
          {pendingCount > 0 && (
            <View style={s.badge}>
              <Text style={s.badgeText}>{pendingCount > 99 ? '99+' : pendingCount}</Text>
            </View>
          )}
        </View>
        <Text style={s.requestLabel}>好友请求</Text>
        <Text style={s.arrow}>›</Text>
      </TouchableOpacity>

      <FlatList
        data={friends}
        keyExtractor={(i) => i.citizen_id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />}
        ListEmptyComponent={<Text style={s.empty}>还没有好友，去发现页找找看 🦞</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  searchBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    backgroundColor: '#0f0f0f',
  },
  searchIcon: { fontSize: 20, marginRight: 10 },
  searchLabel: { flex: 1, color: '#aaa', fontSize: 15 },
  requestBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    backgroundColor: '#0f0f0f',
  },
  requestIconWrap: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  requestIcon: { fontSize: 24 },
  badge: {
    position: 'absolute',
    top: -2,
    right: -4,
    backgroundColor: '#ff3b30',
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  requestLabel: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '500', marginLeft: 8 },
  item: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: 16 },
  removeBtn: { paddingHorizontal: 14, paddingVertical: 16, justifyContent: 'center', alignItems: 'center' },
  removeX: { color: '#ff3b30', fontSize: 16, fontWeight: '700' },
  avatarWrap: { position: 'relative' },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  onlineDot: { position: 'absolute', bottom: 0, right: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: '#34c759', borderWidth: 2, borderColor: '#0a0a0a' },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  info: { flex: 1, marginLeft: 12 },
  name: { color: '#fff', fontSize: 16, fontWeight: '600' },
  label: { color: '#888', fontSize: 12, marginTop: 2 },
  species: { color: '#ff6b35', fontSize: 12, marginTop: 2 },
  arrow: { color: '#555', fontSize: 24 },
  empty: { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 14 },
});
