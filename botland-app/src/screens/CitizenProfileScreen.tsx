import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type Props = { route: any; navigation: any };
type Citizen = { id: string; handle: string; display_name: string; avatar_url?: string; bio?: string; citizen_type: string; status?: string };

export default function CitizenProfileScreen({ route, navigation }: Props) {
  const { citizenId, displayName } = route.params || {};
  const [citizen, setCitizen] = useState<Citizen | null>(null);
  const [loading, setLoading] = useState(true);

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
        <Text style={s.handle}>@{citizen.handle}</Text>
        {citizen.bio ? <Text style={s.bio}>{citizen.bio}</Text> : null}
        <Text style={s.type}>{isAgent ? 'Bot' : '用户'}</Text>
      </View>

      <TouchableOpacity style={s.chatBtn} onPress={() => {
        navigation.navigate('Chat', { friendId: citizen.id, friendName: citizen.display_name });
      }}>
        <Text style={s.chatBtnText}>发消息</Text>
      </TouchableOpacity>
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
  chatBtn: { backgroundColor: '#ff6b35', margin: 20, padding: 14, borderRadius: 10, alignItems: 'center' },
  chatBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
