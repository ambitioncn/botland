import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type Citizen = { citizen_id: string; display_name: string; citizen_type: string; bio?: string; species?: string };
type Props = { navigation: any };

export default function DiscoverScreen({ navigation }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Citizen[]>([]);
  const [trending, setTrending] = useState<Citizen[]>([]);

  useEffect(() => {
    (async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try {
        const res = await api.trending(token);
        setTrending((res.citizens || []) as Citizen[]);
      } catch {}
    })();
  }, []);

  const doSearch = async () => {
    if (!query.trim()) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.search(token, query);
      setResults((res.results || []) as Citizen[]);
    } catch (e: any) {
      Alert.alert('搜索失败', e.message);
    }
  };

  const addFriend = async (targetId: string) => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.sendFriendRequest(token, targetId, '你好，交个朋友吧！');
      Alert.alert('已发送好友请求');
    } catch (e: any) {
      Alert.alert('失败', e.message);
    }
  };

  const renderItem = ({ item }: { item: Citizen }) => (
    <View style={s.item}>
      <View style={[s.avatar, item.citizen_type === 'agent' ? s.agentAvatar : null]}>
        <Text style={s.avatarText}>{item.display_name?.[0] || '?'}</Text>
      </View>
      <View style={s.info}>
        <Text style={s.name}>{item.display_name} {item.citizen_type === 'agent' ? '🤖' : ''}</Text>
        {item.bio ? <Text style={s.bio}>{item.bio}</Text> : null}
        {item.species ? <Text style={s.species}>{item.species}</Text> : null}
      </View>
      <TouchableOpacity style={s.addBtn} onPress={() => addFriend(item.citizen_id)}>
        <Text style={s.addText}>+</Text>
      </TouchableOpacity>
    </View>
  );

  const data = results.length > 0 ? results : trending;

  return (
    <View style={s.container}>
      <View style={s.searchRow}>
        <TextInput style={s.searchInput} placeholder="搜索公民..." placeholderTextColor="#666" value={query} onChangeText={setQuery} onSubmitEditing={doSearch} returnKeyType="search" />
        <TouchableOpacity style={s.searchBtn} onPress={doSearch}>
          <Text style={s.searchBtnText}>搜索</Text>
        </TouchableOpacity>
      </View>
      {results.length === 0 && <Text style={s.sectionTitle}>🔥 热门公民</Text>}
      <FlatList data={data} keyExtractor={(i) => i.citizen_id} renderItem={renderItem} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  searchRow: { flexDirection: 'row', padding: 12 },
  searchInput: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#fff' },
  searchBtn: { backgroundColor: '#ff6b35', borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 8 },
  searchBtnText: { color: '#fff', fontWeight: '700' },
  sectionTitle: { color: '#888', fontSize: 13, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  agentAvatar: { backgroundColor: '#ff6b35' },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  info: { flex: 1, marginLeft: 12 },
  name: { color: '#fff', fontSize: 16, fontWeight: '600' },
  bio: { color: '#888', fontSize: 12, marginTop: 2 },
  species: { color: '#ff6b35', fontSize: 12, marginTop: 2 },
  addBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', justifyContent: 'center', alignItems: 'center' },
  addText: { color: '#ff6b35', fontSize: 20, fontWeight: '700' },
});
