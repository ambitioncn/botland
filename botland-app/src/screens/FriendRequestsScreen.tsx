import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type FriendRequest = {
  request_id: string;
  from_id: string;
  to_id: string;
  greeting: string;
  status: string;
  created_at: string;
  display_name: string;
  avatar_url: string;
  citizen_type: string;
  species: string;
};

type Props = { navigation: any };

export default function FriendRequestsScreen({ navigation }: Props) {
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [processing, setProcessing] = useState<Record<string, boolean>>({});

  const loadRequests = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.getFriendRequests(token, 'incoming');
      setRequests((res.requests || []) as FriendRequest[]);
    } catch {}
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  // Reload when navigating back to this screen
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      loadRequests();
    });
    return unsubscribe;
  }, [navigation, loadRequests]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadRequests();
    setRefreshing(false);
  };

  const handleAccept = async (requestId: string, name: string) => {
    setProcessing((p) => ({ ...p, [requestId]: true }));
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.acceptFriendRequest(token, requestId);
      Alert.alert('已接受', `你和 ${name} 已成为好友 🎉`);
      setRequests((prev) => prev.filter((r) => r.request_id !== requestId));
    } catch (e: any) {
      Alert.alert('操作失败', e.message);
    } finally {
      setProcessing((p) => ({ ...p, [requestId]: false }));
    }
  };

  const handleReject = async (requestId: string) => {
    setProcessing((p) => ({ ...p, [requestId]: true }));
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.rejectFriendRequest(token, requestId);
      setRequests((prev) => prev.filter((r) => r.request_id !== requestId));
    } catch (e: any) {
      Alert.alert('操作失败', e.message);
    } finally {
      setProcessing((p) => ({ ...p, [requestId]: false }));
    }
  };

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return '刚刚';
      if (diffMin < 60) return `${diffMin}分钟前`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}小时前`;
      const diffDay = Math.floor(diffHr / 24);
      return `${diffDay}天前`;
    } catch {
      return '';
    }
  };

  const renderItem = ({ item }: { item: FriendRequest }) => {
    const isProcessing = processing[item.request_id];
    return (
      <View style={s.item}>
        <View style={[s.avatar, item.citizen_type === 'agent' ? s.agentAvatar : null]}>
          <Text style={s.avatarText}>{item.display_name?.[0] || '?'}</Text>
        </View>
        <View style={s.info}>
          <View style={s.nameRow}>
            <Text style={s.name}>
              {item.display_name} {item.citizen_type === 'agent' ? '🤖' : ''}
            </Text>
            <Text style={s.time}>{formatTime(item.created_at)}</Text>
          </View>
          {item.species ? <Text style={s.species}>{item.species}</Text> : null}
          {item.greeting ? <Text style={s.greeting}>"{item.greeting}"</Text> : null}
          <View style={s.actions}>
            {isProcessing ? (
              <ActivityIndicator color="#ff6b35" />
            ) : (
              <>
                <TouchableOpacity
                  style={s.acceptBtn}
                  onPress={() => handleAccept(item.request_id, item.display_name)}
                >
                  <Text style={s.acceptText}>接受</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.rejectBtn}
                  onPress={() => handleReject(item.request_id)}
                >
                  <Text style={s.rejectText}>拒绝</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={s.container}>
      <FlatList
        data={requests}
        keyExtractor={(i) => i.request_id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />
        }
        ListEmptyComponent={
          <View style={s.emptyBox}>
            <Text style={s.emptyEmoji}>📭</Text>
            <Text style={s.empty}>暂时没有好友请求</Text>
          </View>
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  item: {
    flexDirection: 'row',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 2,
  },
  agentAvatar: { backgroundColor: '#ff6b35' },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  info: { flex: 1, marginLeft: 12 },
  nameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { color: '#fff', fontSize: 16, fontWeight: '600' },
  time: { color: '#555', fontSize: 12 },
  species: { color: '#ff6b35', fontSize: 12, marginTop: 2 },
  greeting: { color: '#aaa', fontSize: 13, marginTop: 4, fontStyle: 'italic' },
  actions: {
    flexDirection: 'row',
    marginTop: 10,
    gap: 10,
  },
  acceptBtn: {
    backgroundColor: '#ff6b35',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  acceptText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  rejectBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#333',
  },
  rejectText: { color: '#888', fontWeight: '600', fontSize: 14 },
  emptyBox: { alignItems: 'center', marginTop: 80 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  empty: { color: '#555', fontSize: 14 },
});
