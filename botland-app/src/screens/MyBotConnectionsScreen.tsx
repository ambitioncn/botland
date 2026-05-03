import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, TextInput,
} from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type BotBinding = {
  id: string;
  card_id: string;
  status: string;
  bot: { name: string; slug: string; avatar?: string };
  created_at: string;
};

type Props = { navigation: any };

export default function MyBotConnectionsScreen({ navigation }: Props) {
  const [bindings, setBindings] = useState<BotBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [addMode, setAddMode] = useState(false);
  const [cardInput, setCardInput] = useState('');
  const [binding, setBinding] = useState(false);

  const loadBindings = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.getMyBotBindings(token);
      setBindings(res.bindings);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadBindings(); }, [loadBindings]);

  const handleBind = async () => {
    const trimmed = cardInput.trim();
    if (!trimmed) return;

    setBinding(true);
    try {
      // First resolve the card
      const resolved = await api.resolveBotCard(trimmed);
      if (!resolved?.card) {
        const msg = '名片不存在';
        Alert.alert('添加失败', msg);
        if (typeof window !== 'undefined') window.alert(msg);
        return;
      }

      // Then bind
      const token = await auth.getAccessToken();
      if (!token) {
        const msg = '请先登录';
        Alert.alert('添加失败', msg);
        if (typeof window !== 'undefined') window.alert(msg);
        return;
      }
      const useRes = await api.useBotCard(token, trimmed, 'manual');

      const successMsg = useRes?.result === 'already_friends'
        ? `${resolved.card.bot.name} 已经在你的好友列表里`
        : `已成功添加 ${resolved.card.bot.name} 为好友`;
      Alert.alert(useRes?.result === 'already_friends' ? '已经是好友' : '添加成功', successMsg);
      if (typeof window !== 'undefined') window.alert((useRes?.result === 'already_friends' ? '已经是好友: ' : '添加成功: ') + successMsg);
      setCardInput('');
      setAddMode(false);
      loadBindings();
    } catch (e: any) {
      const errMsg = e?.message || '无效的名片码';
      Alert.alert('添加失败', errMsg);
      if (typeof window !== 'undefined') window.alert('添加失败: ' + errMsg);
    } finally {
      setBinding(false);
    }
  };

  const renderItem = ({ item }: { item: BotBinding }) => (
    <View style={s.card}>
      <View style={s.cardLeft}>
        <Text style={s.botEmoji}>🤖</Text>
      </View>
      <View style={s.cardInfo}>
        <Text style={s.botName}>{item.bot.name}</Text>
        <Text style={s.botSlug}>@{item.bot.slug}</Text>
        <Text style={s.connectedAt}>
          已添加为好友 · {new Date(item.created_at).toLocaleDateString('zh-CN')}
        </Text>
      </View>
      <View style={s.statusBadge}>
        <Text style={s.statusText}>好友</Text>
      </View>
    </View>
  );

  return (
    <View style={s.container}>
      {/* Header action */}
      <TouchableOpacity style={s.addBtn} onPress={() => setAddMode(!addMode)}>
        <Text style={s.addBtnText}>{addMode ? '取消' : '+ 通过 Bot Card 添加好友'}</Text>
      </TouchableOpacity>

      {/* Add card input */}
      {addMode && (
        <View style={s.addSection}>
          <TextInput
            style={s.input}
            placeholder="输入 Bot Card 名片码或粘贴名片链接"
            placeholderTextColor="#666"
            value={cardInput}
            onChangeText={setCardInput}
            autoCapitalize="characters"
          />
          <TouchableOpacity style={s.bindBtn} onPress={handleBind} disabled={binding || !cardInput.trim()}>
            {binding ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={s.bindBtnText}>添加好友</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* List */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color="#ff6b35" />
        </View>
      ) : bindings.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyIcon}>🔗</Text>
          <Text style={s.emptyTitle}>还没有添加任何 Bot 好友</Text>
          <Text style={s.emptyDesc}>通过 Bot Card 名片码添加你的第一个 Bot 好友</Text>
          {!addMode && (
            <TouchableOpacity style={s.emptyBtn} onPress={() => setAddMode(true)}>
              <Text style={s.emptyBtnText}>通过 Bot Card 添加好友</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={bindings}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  addBtn: {
    alignSelf: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 12,
  },
  addBtnText: { color: '#ff6b35', fontSize: 14, fontWeight: '600' },

  addSection: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: '#fff',
    borderWidth: 1,
    borderColor: '#333',
  },
  bindBtn: {
    backgroundColor: '#ff6b35',
    borderRadius: 12,
    paddingHorizontal: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bindBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  list: { paddingBottom: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#1a1a1a',
  },
  cardLeft: { marginRight: 12 },
  botEmoji: { fontSize: 32 },
  cardInfo: { flex: 1 },
  botName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  botSlug: { color: '#888', fontSize: 13, marginTop: 2 },
  connectedAt: { color: '#555', fontSize: 11, marginTop: 4 },
  statusBadge: {
    backgroundColor: '#1a2a1a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusText: { color: '#6c6', fontSize: 11, fontWeight: '600' },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingBottom: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { color: '#888', fontSize: 18, fontWeight: '600', marginBottom: 8 },
  emptyDesc: { color: '#555', fontSize: 14 },
  emptyBtn: {
    marginTop: 20,
    backgroundColor: '#ff6b35',
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  emptyBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
