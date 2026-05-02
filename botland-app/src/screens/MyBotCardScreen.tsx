import React, { useEffect, useMemo, useState } from 'react';
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
  expires_at: string;
};

export default function MyBotCardScreen({ navigation }: { navigation: any }) {
  const [card, setCard] = useState<BotCardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nowTs, setNowTs] = useState(Date.now());

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

  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const expiryInfo = useMemo(() => {
    if (!card?.expires_at) return null;
    const exp = new Date(card.expires_at).getTime();
    const diffMs = exp - nowTs;
    if (diffMs <= 0) return { expired: true, text: 'Bot Card 已过期，请重新分享新的名片' };
    const mins = Math.max(1, Math.ceil(diffMs / 60000));
    return { expired: false, text: `该 Bot Card 还有 ${mins} 分钟过期` };
  }, [card?.expires_at, nowTs]);

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
        {expiryInfo ? (
          <View style={[s.expiryBox, expiryInfo.expired ? s.expiryExpired : s.expiryActive]}>
            <Text style={[s.expiryText, expiryInfo.expired ? s.expiryTextExpired : s.expiryTextActive]}>
              {expiryInfo.text}
            </Text>
          </View>
        ) : null}
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
  expiryBox: { marginTop: 14, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, width: '100%' },
  expiryActive: { backgroundColor: 'rgba(255,107,53,0.12)', borderWidth: 1, borderColor: 'rgba(255,107,53,0.28)' },
  expiryExpired: { backgroundColor: 'rgba(255,80,80,0.10)', borderWidth: 1, borderColor: 'rgba(255,80,80,0.26)' },
  expiryText: { fontSize: 13, textAlign: 'center', fontWeight: '600' },
  expiryTextActive: { color: '#ffb08a' },
  expiryTextExpired: { color: '#ff8a8a' },
  btn: { backgroundColor: '#ff6b35', borderRadius: 12, padding: 16, alignItems: 'center', width: '100%', marginBottom: 12 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnSecondary: { backgroundColor: '#111', borderRadius: 12, padding: 16, alignItems: 'center', width: '100%', marginBottom: 12, borderWidth: 1, borderColor: '#222' },
  btnSecondaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  errorIcon: { fontSize: 48, marginBottom: 12 },
  errorText: { color: '#888', fontSize: 16, marginBottom: 24, textAlign: 'center' },
});
