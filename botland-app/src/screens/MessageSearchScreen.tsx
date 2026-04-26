import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type SearchResult = {
  id: string;
  chat_id: string;
  chat_type: 'direct' | 'group';
  from_id: string;
  from_name: string;
  text: string;
  content_type: string;
  timestamp: string;
  peer_name?: string;
};

type Props = { navigation: any };

export default function MessageSearchScreen({ navigation }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setLoading(true);
    setSearched(true);
    try {
      const token = await auth.getAccessToken();
      if (!token) return;
      const res = await fetch(`https://api.botland.im/api/v1/messages/search?q=${encodeURIComponent(q)}&limit=30`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setResults(data.results || []);
    } catch (e) {
      console.error('Search failed:', e);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const highlightText = (text: string, q: string) => {
    if (!q || !text) return <Text style={s.resultText}>{text}</Text>;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return <Text style={s.resultText}>{text}</Text>;
    return (
      <Text style={s.resultText}>
        {text.slice(0, idx)}
        <Text style={s.highlight}>{text.slice(idx, idx + q.length)}</Text>
        {text.slice(idx + q.length)}
      </Text>
    );
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 86400000) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (diff < 7 * 86400000) return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()] + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const onPress = (item: SearchResult) => {
    if (item.chat_type === 'group') {
      navigation.navigate('Chat', { groupId: item.chat_id, groupName: item.peer_name || '群聊', chatType: 'group' });
    } else {
      navigation.navigate('Chat', { friendId: item.chat_id, friendName: item.peer_name || '聊天' });
    }
  };

  const renderItem = ({ item }: { item: SearchResult }) => (
    <TouchableOpacity style={s.item} onPress={() => onPress(item)} activeOpacity={0.7}>
      <View style={s.itemHeader}>
        <View style={[s.badge, item.chat_type === 'group' ? s.badgeGroup : s.badgeDM]}>
          <Text style={s.badgeText}>{item.chat_type === 'group' ? '群' : 'DM'}</Text>
        </View>
        <Text style={s.peerName} numberOfLines={1}>{item.peer_name || item.chat_id.slice(-6)}</Text>
        <Text style={s.time}>{formatTime(item.timestamp)}</Text>
      </View>
      <View style={s.itemBody}>
        <Text style={s.fromName}>{item.from_name || '未知'}：</Text>
        {highlightText(item.text?.slice(0, 120) || (item.content_type === 'image' ? '[图片]' : item.content_type === 'video' ? '[视频]' : ''), query.trim())}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={s.container}>
      <View style={s.searchRow}>
        <TextInput
          style={s.input}
          placeholder="搜索聊天记录..."
          placeholderTextColor="#666"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={doSearch}
          returnKeyType="search"
          autoFocus
        />
        <TouchableOpacity style={s.btn} onPress={doSearch}>
          <Text style={s.btnText}>搜索</Text>
        </TouchableOpacity>
      </View>

      {loading && <ActivityIndicator color="#ff6b35" style={{ marginTop: 40 }} />}

      <FlatList
        data={results}
        keyExtractor={i => i.id}
        renderItem={renderItem}
        ListEmptyComponent={searched && !loading ? <Text style={s.empty}>没有找到相关消息</Text> : null}
        contentContainerStyle={s.list}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  searchRow: { flexDirection: 'row', padding: 12, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  input: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#fff' },
  btn: { backgroundColor: '#ff6b35', borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 8 },
  btnText: { color: '#fff', fontWeight: '700' },
  list: { paddingBottom: 40 },
  item: { padding: 14, borderBottomWidth: 1, borderBottomColor: '#141414' },
  itemHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginRight: 8 },
  badgeDM: { backgroundColor: '#ff6b3530' },
  badgeGroup: { backgroundColor: '#3b82f630' },
  badgeText: { fontSize: 11, fontWeight: '600', color: '#ff6b35' },
  peerName: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '600' },
  time: { color: '#555', fontSize: 12 },
  itemBody: { flexDirection: 'row', flexWrap: 'wrap' },
  fromName: { color: '#888', fontSize: 13 },
  resultText: { color: '#aaa', fontSize: 13, flexShrink: 1 },
  highlight: { color: '#ff6b35', fontWeight: '700' },
  empty: { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 14 },
});
