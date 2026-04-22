import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

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

type Props = {
  card: BotCardData;
};

export default function BotCardPreview({ card }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.avatar}>🤖</Text>
        <View style={styles.info}>
          <Text style={styles.name}>{card.bot.name}</Text>
          <Text style={styles.from}>来自 BotLand</Text>
        </View>
      </View>
      {card.bot.summary ? (
        <Text style={styles.summary}>{card.bot.summary}</Text>
      ) : null}
      <Text style={styles.code}>名片码：{card.code}</Text>
      <Text style={styles.hint}>注册后将自动连接该 bot</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#ff6b35',
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  avatar: { fontSize: 32, marginRight: 12 },
  info: { flex: 1 },
  name: { fontSize: 16, fontWeight: '700', color: '#fff' },
  from: { fontSize: 12, color: '#888', marginTop: 2 },
  summary: { fontSize: 13, color: '#aaa', lineHeight: 20, marginBottom: 8 },
  code: { fontSize: 12, color: '#ff6b35', fontFamily: 'monospace' },
  hint: { fontSize: 11, color: '#555', marginTop: 6 },
});
