import React, { useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import api, { RelationshipSummary } from '../services/api';
import auth from '../services/auth';

type Props = { route: any; navigation: any };
type Citizen = {
  citizen_id: string;
  handle: string;
  display_name: string;
  avatar_url?: string;
  bio?: string;
  citizen_type: string;
  status?: string;
  species?: string;
};

function formatSince(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('zh-CN');
}

export default function CitizenProfileScreen({ route, navigation }: Props) {
  const { citizenId, displayName } = route.params || {};
  const [citizen, setCitizen] = useState<Citizen | null>(null);
  const [summary, setSummary] = useState<RelationshipSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const loadProfile = async () => {
    const token = await auth.getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const [citizenData, summaryData] = await Promise.all([
        api.getCitizen(token, citizenId),
        api.getRelationshipSummary(token, citizenId),
      ]);
      setCitizen(citizenData as unknown as Citizen);
      setSummary(summaryData);
    } catch {
      setCitizen(null);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    navigation.setOptions({ title: displayName || '用户资料' });
    loadProfile();
  }, [citizenId]);

  const reloadSummary = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    const summaryData = await api.getRelationshipSummary(token, citizenId);
    setSummary(summaryData);
  };

  const handleSendFriendRequest = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      setActionLoading(true);
      await api.sendFriendRequest(token, citizenId);
      await reloadSummary();
    } catch (error) {
      Alert.alert('操作失败', error instanceof Error ? error.message : '发送好友请求失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAcceptRequest = async () => {
    if (!summary?.friend_request_id) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      setActionLoading(true);
      await api.acceptFriendRequest(token, summary.friend_request_id);
      await reloadSummary();
    } catch (error) {
      Alert.alert('操作失败', error instanceof Error ? error.message : '接受好友请求失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectRequest = async () => {
    if (!summary?.friend_request_id) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      setActionLoading(true);
      await api.rejectFriendRequest(token, summary.friend_request_id);
      await reloadSummary();
    } catch (error) {
      Alert.alert('操作失败', error instanceof Error ? error.message : '拒绝好友请求失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveFriend = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      setActionLoading(true);
      await api.removeFriend(token, citizenId);
      await reloadSummary();
    } catch (error) {
      Alert.alert('操作失败', error instanceof Error ? error.message : '删除好友失败');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return <View style={s.center}><ActivityIndicator size="large" color="#ff6b35" /></View>;
  }
  if (!citizen) {
    return <View style={s.center}><Text style={s.empty}>无法加载用户资料</Text></View>;
  }

  const isAgent = citizen.citizen_type === 'agent';
  const friendsSince = formatSince(summary?.friends_since ?? null);

  return (
    <View style={s.container}>
      <View style={s.card}>
        {citizen.avatar_url ? (
          <Image source={{ uri: citizen.avatar_url }} style={s.avatar} />
        ) : (
          <View style={[s.avatarFallback, isAgent && s.avatarFallbackAgent]}>
            <Text style={s.avatarText}>{(citizen.display_name || '?')[0]}</Text>
          </View>
        )}
        <Text style={s.name}>{isAgent ? '🤖 ' : ''}{citizen.display_name}</Text>
        <Text style={s.handle}>@{citizen.handle}</Text>
        {citizen.bio ? <Text style={s.bio}>{citizen.bio}</Text> : null}
        <View style={s.badgeRow}>
          <Text style={s.typeBadge}>{isAgent ? 'Bot' : '用户'}</Text>
          {summary?.is_online ? <Text style={s.onlineBadge}>在线</Text> : null}
        </View>
        {citizen.species ? <Text style={s.species}>{citizen.species}</Text> : null}
      </View>

      {summary ? (
        <View style={s.summaryCard}>
          <Text style={s.summaryTitle}>关系摘要</Text>
          {summary.relationship_status === 'none' ? (
            <>
              <Text style={s.summaryText}>还没有共同历史，可以先加好友开始建立联系。</Text>
              <TouchableOpacity style={s.primaryBtn} onPress={handleSendFriendRequest} disabled={actionLoading}>
                <Text style={s.primaryBtnText}>{actionLoading ? '处理中...' : '加好友'}</Text>
              </TouchableOpacity>
            </>
          ) : null}

          {summary.relationship_status === 'request_sent' ? (
            <Text style={s.summaryText}>好友请求已发送，等待对方确认。</Text>
          ) : null}

          {summary.relationship_status === 'request_received' ? (
            <>
              <Text style={s.summaryText}>对方向你发来了好友请求。</Text>
              <View style={s.actionRow}>
                <TouchableOpacity style={s.primaryHalfBtn} onPress={handleAcceptRequest} disabled={actionLoading}>
                  <Text style={s.primaryBtnText}>{actionLoading ? '处理中...' : '接受'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.secondaryHalfBtn} onPress={handleRejectRequest} disabled={actionLoading}>
                  <Text style={s.secondaryBtnText}>拒绝</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : null}

          {summary.relationship_status === 'friends' ? (
            <>
              <Text style={s.summaryText}>{friendsSince ? `你们已是好友（${friendsSince}）` : '你们已是好友。'}</Text>
              <View style={s.metricRow}>
                <Text style={s.metricLabel}>私聊消息</Text>
                <Text style={s.metricValue}>{summary.dm_count}</Text>
              </View>
              <View style={s.metricRow}>
                <Text style={s.metricLabel}>共同群聊</Text>
                <Text style={s.metricValue}>{summary.shared_groups.length}</Text>
              </View>
              <View style={s.metricRow}>
                <Text style={s.metricLabel}>共同 Bot</Text>
                <Text style={s.metricValue}>{summary.shared_bots.length}</Text>
              </View>
              {summary.shared_groups.length > 0 ? (
                <Text style={s.detailText}>共同群聊：{summary.shared_groups.map((group) => group.group_name).join('、')}</Text>
              ) : null}
              {summary.shared_bots.length > 0 ? (
                <Text style={s.detailText}>共同 Bot：{summary.shared_bots.map((bot) => bot.bot_name).join('、')}</Text>
              ) : null}
              {summary.my_label ? <Text style={s.detailText}>我的备注：{summary.my_label}</Text> : null}
              {summary.their_label ? <Text style={s.detailText}>对方对你的备注：{summary.their_label}</Text> : null}
              <TouchableOpacity style={s.secondaryBtn} onPress={handleRemoveFriend} disabled={actionLoading}>
                <Text style={s.secondaryBtnText}>{actionLoading ? '处理中...' : '删除好友'}</Text>
              </TouchableOpacity>
            </>
          ) : null}

          {summary.relationship_status === 'blocked' ? (
            <Text style={s.summaryText}>当前关系已被屏蔽，暂时无法继续互动。</Text>
          ) : null}
        </View>
      ) : null}

      <TouchableOpacity
        style={s.chatBtn}
        onPress={() => navigation.navigate('Chat', { friendId: citizen.citizen_id, friendName: citizen.display_name })}
      >
        <Text style={s.chatBtnText}>发消息</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', padding: 20 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a', padding: 24 },
  empty: { color: '#555', textAlign: 'center' },
  card: {
    alignItems: 'center',
    padding: 30,
    borderRadius: 20,
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#222',
    marginBottom: 16,
  },
  avatar: { width: 80, height: 80, borderRadius: 40 },
  avatarFallback: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  avatarFallbackAgent: { backgroundColor: '#3b82f6' },
  avatarText: { color: '#fff', fontSize: 36, fontWeight: '700' },
  name: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 14 },
  handle: { color: '#888', fontSize: 14, marginTop: 4 },
  bio: { color: '#aaa', fontSize: 14, marginTop: 10, textAlign: 'center', paddingHorizontal: 20, lineHeight: 20 },
  badgeRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  typeBadge: { color: '#ff6b35', fontSize: 12, borderWidth: 1, borderColor: '#ff6b35', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  onlineBadge: { color: '#34c759', fontSize: 12, borderWidth: 1, borderColor: '#34c759', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  species: { color: '#666', fontSize: 12, marginTop: 10 },
  summaryCard: {
    backgroundColor: '#111',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1a1a1a',
    padding: 18,
    marginBottom: 16,
  },
  summaryTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 10 },
  summaryText: { color: '#ddd', fontSize: 14, lineHeight: 20, marginBottom: 12 },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  metricLabel: { color: '#888', fontSize: 13 },
  metricValue: { color: '#fff', fontSize: 13, fontWeight: '600' },
  detailText: { color: '#aaa', fontSize: 13, lineHeight: 18, marginTop: 4 },
  actionRow: { flexDirection: 'row', gap: 10 },
  primaryBtn: { backgroundColor: '#ff6b35', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryHalfBtn: { flex: 1, backgroundColor: '#ff6b35', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryBtn: { marginTop: 14, backgroundColor: '#1a1a1a', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  secondaryHalfBtn: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  secondaryBtnText: { color: '#ddd', fontSize: 15, fontWeight: '600' },
  chatBtn: { backgroundColor: '#ff6b35', padding: 14, borderRadius: 12, alignItems: 'center' },
  chatBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
