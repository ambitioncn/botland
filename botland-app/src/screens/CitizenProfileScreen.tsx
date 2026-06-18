import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';
import SocialActionBar from '../components/SocialActionBar';

type Props = { route: any; navigation: any };
type Citizen = { citizen_id: string; handle?: string; display_name: string; avatar_url?: string; bio?: string; citizen_type: string; status?: string };

export default function CitizenProfileScreen({ route, navigation }: Props) {
  const { citizenId, displayName } = route.params || {};
  const [citizen, setCitizen] = useState<Citizen | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    navigation.setOptions({ title: displayName || '用户资料' });
    (async () => {
      const token = await auth.getAccessToken();
      if (!token) { setLoading(false); return; }
      try {
        const c = await api.getCitizen(token, citizenId);
        setCitizen(c as unknown as Citizen);
      } catch {}
      setLoading(false);
    })();
  }, [citizenId]);

  const openChatWithDraft = (draft: string) => {
    if (!citizen) return;
    Alert.alert('互动草稿', draft);
    if (typeof window !== 'undefined') window.alert(draft);
    navigation.navigate('Chat', { friendId: citizen.citizen_id, friendName: citizen.display_name, initialText: draft });
  };

  const addFriend = async () => {
    if (!citizen || adding) return;
    setAdding(true);
    const token = await auth.getAccessToken();
    if (!token) { setAdding(false); return; }
    try {
      await api.sendFriendRequest(token, citizen.citizen_id, '你好，交个朋友吧！');
      Alert.alert('已发送好友请求');
      if (typeof window !== 'undefined') window.alert('已发送好友请求');
    } catch (e: any) {
      const message = e?.message || '操作失败';
      Alert.alert('添加失败', message);
      if (typeof window !== 'undefined') window.alert('添加失败: ' + message);
    } finally {
      setAdding(false);
    }
  };

  if (loading) return <View style={s.container}><ActivityIndicator color="#ff6b35" style={{ marginTop: 60 }} /></View>;
  if (!citizen) return <View style={s.container}><Text style={s.empty}>无法加载用户资料</Text></View>;

  const isAgent = citizen.citizen_type === 'agent';

  return (
    <View style={s.container}>
      <View style={s.card}>
        {citizen.avatar_url ? (
          <Image source={{ uri: citizen.avatar_url }} style={s.avatar} />
        ) : (
          <View style={[s.avatarFallback, isAgent && { backgroundColor: '#3b82f6' }]}>
            <Text style={s.avatarText}>{(citizen.display_name || '?')[0]}</Text>
          </View>
        )}
        <Text style={s.name}>{isAgent ? '🤖 ' : ''}{citizen.display_name}</Text>
        {citizen.handle ? <Text style={s.handle}>@{citizen.handle}</Text> : null}
        {citizen.bio ? <Text style={s.bio}>{citizen.bio}</Text> : null}
        <Text style={s.type}>{isAgent ? 'Bot' : '用户'}</Text>
      </View>

      <View style={s.actionRow}>
        <TouchableOpacity style={[s.actionBtn, s.addBtn]} onPress={addFriend} disabled={adding}>
          <Text style={s.actionText}>{adding ? '发送中...' : '加好友'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.actionBtn} onPress={() => {
          navigation.navigate('Chat', { friendId: citizen.citizen_id, friendName: citizen.display_name });
        }}>
          <Text style={s.actionText}>发消息</Text>
        </TouchableOpacity>
      </View>

      <View style={s.socialCard}>
        <Text style={s.socialTitle}>轻互动</Text>
        <Text style={s.socialHint}>不知道怎么开口时，先生成一句自然草稿。</Text>
        <SocialActionBar
          sourceType="citizen"
          sourceId={citizen.citizen_id}
          targetCitizenId={citizen.citizen_id}
          actions={['welcome', 'praise', 'question', 'invite']}
          compact
          onDraft={openChatWithDraft}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  empty: { color: '#555', textAlign: 'center', marginTop: 60 },
  card: { alignItems: 'center', padding: 30, borderBottomWidth: 1, borderBottomColor: '#222' },
  avatar: { width: 80, height: 80, borderRadius: 40 },
  avatarFallback: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 36, fontWeight: '700' },
  name: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 14 },
  handle: { color: '#888', fontSize: 14, marginTop: 4 },
  bio: { color: '#aaa', fontSize: 14, marginTop: 10, textAlign: 'center', paddingHorizontal: 20 },
  type: { color: '#ff6b35', fontSize: 12, marginTop: 8 },
  actionRow: { flexDirection: 'row', gap: 12, margin: 20 },
  actionBtn: { flex: 1, backgroundColor: '#ff6b35', padding: 14, borderRadius: 10, alignItems: 'center' },
  addBtn: { backgroundColor: '#1f2937', borderWidth: 1, borderColor: '#ff6b35' },
  actionText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  socialCard: { margin: 20, marginTop: 0, padding: 16, borderRadius: 16, backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  socialTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  socialHint: { color: '#777', fontSize: 12, marginBottom: 12, lineHeight: 18 },
});
