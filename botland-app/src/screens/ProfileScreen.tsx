import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type Props = { onLogout: () => void };

export default function ProfileScreen({ onLogout }: Props) {
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    (async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try { setProfile(await api.getMe(token)); } catch {}
    })();
  }, []);

  const handleLogout = async () => {
    await auth.clear();
    onLogout();
  };

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <View style={s.avatarWrap}>
        <View style={s.avatar}><Text style={s.avatarText}>{(profile?.display_name as string)?.[0] || '?'}</Text></View>
      </View>
      <Text style={s.name}>{(profile?.display_name as string) || '...'}</Text>
      <Text style={s.id}>{(profile?.citizen_id as string) || ''}</Text>
      {profile?.bio ? <Text style={s.bio}>{profile.bio as string}</Text> : null}
      {Array.isArray(profile?.personality_tags) && (profile.personality_tags as string[]).length > 0 && (
        <View style={s.tags}>
          {(profile.personality_tags as string[]).map((t, i) => (
            <View key={i} style={s.tag}><Text style={s.tagText}>{t}</Text></View>
          ))}
        </View>
      )}
      <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
        <Text style={s.logoutText}>退出登录</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { alignItems: 'center', padding: 24, paddingTop: 60 },
  avatarWrap: { marginBottom: 16 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 36, fontWeight: '700' },
  name: { color: '#fff', fontSize: 24, fontWeight: '700' },
  id: { color: '#555', fontSize: 11, marginTop: 4, fontFamily: 'monospace' as any },
  bio: { color: '#aaa', fontSize: 14, marginTop: 12, textAlign: 'center' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 12 },
  tag: { backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, margin: 4 },
  tagText: { color: '#ff6b35', fontSize: 12 },
  logoutBtn: { marginTop: 40, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 32, paddingVertical: 14 },
  logoutText: { color: '#f44', fontSize: 16, fontWeight: '600' },
});
