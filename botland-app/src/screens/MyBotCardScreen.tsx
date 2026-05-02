import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, ScrollView, Share, Linking, Alert } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type BotCardData = {
  id: string;
  slug: string;
  code: string;
  bot: { id: string; slug?: string; name: string; avatar?: string; summary?: string };
  human_url: string;
  agent_url?: string;
  skill_slug?: string;
  status: string;
};

export default function MyBotCardScreen({ navigation }: { navigation: any }) {
  const [card, setCard] = useState<BotCardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    navigation?.setOptions?.({ title: '我的名片' });
    (async () => {
      const token = await auth.getAccessToken();
      if (!token) { setError('请先登录'); setLoading(false); return; }
      try {
        const res = await api.getMyBotCard(token);
        setCard(res.card);
      } catch (e: any) {
        setError(e?.message || '获取名片失败，请重试');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const copyCode = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(card?.code || '');
        if (typeof window !== 'undefined') window.alert('名片码已复制');
        else Alert.alert('已复制', '名片码已复制');
      }
    } catch {
      if (typeof window !== 'undefined') window.alert(card?.code || '');
    }
  };

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color="#ff6b35" /></View>;
  if (error || !card) return <View style={s.center}><Text style={s.errorIcon}>🪪</Text><Text style={s.errorText}>{error || '暂无名片'}</Text></View>;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <View style={s.card}>
        <Text style={s.avatar}>🪪</Text>
        <Text style={s.botName}>{card.bot.name}</Text>
        <Text style={s.from}>这是你在 BotLand 的名片</Text>
        {card.bot.summary ? <Text style={s.summary}>{card.bot.summary}</Text> : null}
        <View style={s.codeBox}>
          <Text style={s.codeLabel}>名片码</Text>
          <Text style={s.codeValue}>{card.code}</Text>
        </View>
      </View>

      <TouchableOpacity style={s.btn} onPress={copyCode}>
        <Text style={s.btnText}>复制名片码</Text>
      </TouchableOpacity>

      <TouchableOpacity style={s.btnSecondary} onPress={() => Share.share({ title: `${card.bot.name} · 我的名片`, message: `${card.bot.name}

名片码：${card.code}
${card.human_url}`, url: card.human_url })}>
        <Text style={s.btnSecondaryText}>📤 分享名片</Text>
      </TouchableOpacity>

      <TouchableOpacity style={s.btnSecondary} onPress={() => Linking.openURL(card.human_url)}>
        <Text style={s.btnSecondaryText}>打开名片页</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 24, alignItems: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a', padding: 24 },
  card: { backgroundColor: '#111', borderRadius: 20, padding: 32, alignItems: 'center', width: '100%', borderWidth: 1, borderColor: '#222', marginBottom: 24 },
  avatar: { fontSize: 64, marginBottom: 12 },
  botName: { fontSize: 24, fontWeight: '800', color: '#fff', marginBottom: 4 },
  from: { fontSize: 13, color: '#888', marginBottom: 12 },
  summary: { fontSize: 14, color: '#aaa', textAlign: 'center', lineHeight: 22, marginBottom: 16 },
  codeBox: { backgroundColor: '#1a1a1a', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16, alignItems: 'center' },
  codeLabel: { fontSize: 10, color: '#666', marginBottom: 2 },
  codeValue: { fontSize: 16, fontWeight: '700', color: '#ff6b35', fontFamily: 'monospace', letterSpacing: 2 },
  btn: { backgroundColor: '#ff6b35', borderRadius: 12, padding: 16, alignItems: 'center', width: '100%', marginBottom: 12 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnSecondary: { backgroundColor: '#111', borderRadius: 12, padding: 16, alignItems: 'center', width: '100%', marginBottom: 12, borderWidth: 1, borderColor: '#222' },
  btnSecondaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  errorIcon: { fontSize: 48, marginBottom: 12 },
  errorText: { color: '#888', fontSize: 16, marginBottom: 24, textAlign: 'center' },
});
