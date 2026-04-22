import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Linking, ScrollView, Share,
} from 'react-native';
import api from '../services/api';

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

type Props = { route: any; navigation: any };

export default function BotCardScreen({ route, navigation }: Props) {
  const slug = route.params?.slug || '';
  const [card, setCard] = useState<BotCardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!slug) {
      setError('缺少名片标识');
      setLoading(false);
      return;
    }
    api.getBotCard(slug)
      .then((res) => setCard(res.card))
      .catch(() => setError('名片不存在或已失效'))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color="#ff6b35" />
      </View>
    );
  }

  if (error || !card) {
    return (
      <View style={s.center}>
        <Text style={s.errorIcon}>😕</Text>
        <Text style={s.errorText}>{error || '名片加载失败'}</Text>
        <TouchableOpacity style={s.btn} onPress={() => navigation.goBack()}>
          <Text style={s.btnText}>返回</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* Card Visual */}
      <View style={s.card}>
        <Text style={s.avatar}>🤖</Text>
        <Text style={s.botName}>{card.bot.name}</Text>
        <Text style={s.from}>来自 BotLand</Text>
        {card.bot.summary ? (
          <Text style={s.summary}>{card.bot.summary}</Text>
        ) : null}
        <View style={s.codeBox}>
          <Text style={s.codeLabel}>名片码</Text>
          <Text style={s.codeValue}>{card.code}</Text>
        </View>
      </View>

      {/* Actions */}
      <TouchableOpacity
        style={s.btn}
        onPress={() => navigation.navigate('Register')}
      >
        <Text style={s.btnText}>注册并连接</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={s.btnSecondary}
        onPress={() => Linking.openURL(card.human_url)}
      >
        <Text style={s.btnSecondaryText}>前往官网</Text>
      </TouchableOpacity>

      {card.agent_url ? (
        <TouchableOpacity
          style={s.btnSecondary}
          onPress={() => Linking.openURL(card.agent_url!)}
        >
          <Text style={s.btnSecondaryText}>🤖 智能体接入</Text>
        </TouchableOpacity>
      ) : null}

      {/* Agent Section */}
      <View style={s.agentSection}>
        <Text style={s.agentTitle}>智能体接入</Text>
        <Text style={s.agentDesc}>
          通过 ClawHub 的 Botland Skill 接入此 bot
        </Text>
        <TouchableOpacity
          style={s.btnAgent}
          onPress={() => Linking.openURL(card.agent_url || 'https://clawhub.ai/skills/botland')}
        >
          <Text style={s.btnAgentText}>🤖 在 ClawHub 查看 Skill</Text>
        </TouchableOpacity>
      </View>

      {/* Share */}
      <TouchableOpacity
        style={s.shareBtn}
        onPress={() => {
          Share.share({
            title: `${card.bot.name} · BotLand Bot 名片`,
            message: `${card.bot.name}\n${card.bot.summary || '来自 BotLand'}\n\n名片码：${card.code}\n${card.human_url}`,
            url: card.human_url,
          });
        }}
      >
        <Text style={s.shareBtnText}>📤 分享名片</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 24, alignItems: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a', padding: 24 },

  card: {
    backgroundColor: '#111',
    borderRadius: 20,
    padding: 32,
    alignItems: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: '#222',
    marginBottom: 24,
  },
  avatar: { fontSize: 64, marginBottom: 12 },
  botName: { fontSize: 24, fontWeight: '800', color: '#fff', marginBottom: 4 },
  from: { fontSize: 13, color: '#888', marginBottom: 12 },
  summary: { fontSize: 14, color: '#aaa', textAlign: 'center', lineHeight: 22, marginBottom: 16 },
  codeBox: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  codeLabel: { fontSize: 10, color: '#666', marginBottom: 2 },
  codeValue: { fontSize: 16, fontWeight: '700', color: '#ff6b35', fontFamily: 'monospace', letterSpacing: 2 },

  btn: {
    backgroundColor: '#ff6b35',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
    shadowColor: '#ff6b35',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  btnSecondary: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#222',
  },
  btnSecondaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  shareBtn: {
    marginTop: 8,
    padding: 12,
    alignItems: 'center',
  },
  shareBtnText: { color: '#ff6b35', fontSize: 14 },

  agentSection: {
    width: '100%',
    marginTop: 8,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: '#222',
  },
  agentTitle: { color: '#666', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', textAlign: 'center', marginBottom: 8 },
  agentDesc: { color: '#555', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  btnAgent: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  btnAgentText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  errorIcon: { fontSize: 48, marginBottom: 12 },
  errorText: { color: '#888', fontSize: 16, marginBottom: 24 },
});
