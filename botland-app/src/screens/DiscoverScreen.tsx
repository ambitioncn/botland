import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type Citizen = {
  citizen_id: string;
  handle?: string;
  display_name: string;
  citizen_type: string;
  bio?: string;
  species?: string;
  capabilities?: string[];
};
type Props = { navigation: any };
type TypeFilter = 'all' | 'agent' | 'human';

export default function DiscoverScreen({ navigation }: Props) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [results, setResults] = useState<Citizen[]>([]);
  const [trending, setTrending] = useState<Citizen[]>([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    (async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try {
        const res = await api.trending(token);
        setTrending(((res as any).results || (res as any).citizens || []) as Citizen[]);
      } catch {}
    })();
  }, []);

  const runSearch = async (searchText = query, filter = typeFilter) => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.search(token, searchText.trim(), filter === 'all' ? undefined : filter);
      setResults((res.results || []) as Citizen[]);
      setSearched(true);
    } catch (e: any) {
      const msg = '搜索失败: ' + (e?.message || '未知错误');
      Alert.alert('搜索失败', e.message);
      if (typeof window !== 'undefined') window.alert(msg);
    }
  };

  const doSearch = () => runSearch();

  const selectFilter = (filter: TypeFilter) => {
    setTypeFilter(filter);
    if (searched || query.trim() || filter !== 'all') runSearch(query, filter);
  };

  const selectCapability = (capability: string) => {
    setQuery(capability);
    setTypeFilter('agent');
    runSearch(capability, 'agent');
  };

  const addFriend = async (targetId: string) => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.sendFriendRequest(token, targetId, '你好，交个朋友吧！');
      Alert.alert('已发送好友请求');
      if (typeof window !== 'undefined') window.alert('已发送好友请求');
    } catch (e: any) {
      const msg2 = e?.message || '操作失败';
      Alert.alert('失败', msg2);
      if (typeof window !== 'undefined') window.alert('失败: ' + msg2);
    }
  };

  const capabilityOptions = Array.from(new Set(
    trending
      .filter((c) => c.citizen_type === 'agent')
      .flatMap((c) => Array.isArray(c.capabilities) ? c.capabilities : [])
      .filter(Boolean)
  )).slice(0, 8);

  const renderItem = ({ item }: { item: Citizen }) => (
    <TouchableOpacity style={s.item} activeOpacity={0.82} onPress={() => navigation.navigate('CitizenProfile', { citizenId: item.citizen_id, displayName: item.display_name })}>
      <View style={s.itemMain}>
        <View style={[s.avatar, item.citizen_type === 'agent' ? s.agentAvatar : null]}>
          <Text style={s.avatarText}>{item.display_name?.[0] || '?'}</Text>
        </View>
        <View style={s.info}>
          <Text style={s.name}>{item.display_name} {item.citizen_type === 'agent' ? 'Agent' : ''}</Text>
          {item.handle ? <Text style={s.handle}>@{item.handle}</Text> : null}
          {item.bio ? <Text style={s.bio}>{item.bio}</Text> : null}
          {item.species ? <Text style={s.species}>{item.species}</Text> : null}
          {Array.isArray(item.capabilities) && item.capabilities.length > 0 ? (
            <View style={s.resultChips}>
              {item.capabilities.slice(0, 3).map((capability, index) => (
                <Text key={`${item.citizen_id}-${capability}-${index}`} style={s.resultChip}>{capability}</Text>
              ))}
            </View>
          ) : null}
        </View>
      </View>
      <TouchableOpacity style={s.addBtn} onPress={(e: any) => { e?.stopPropagation?.(); addFriend(item.citizen_id); }}>
        <Text style={s.addText}>加好友</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );

  const data = searched ? results : trending;
  const heading = searched ? `搜索结果 ${results.length}` : '热门公民';

  return (
    <View style={s.container}>
      <View style={s.searchRow}>
        <TextInput style={s.searchInput} placeholder="搜索公民、能力或服务..." placeholderTextColor="#666" value={query} onChangeText={setQuery} onSubmitEditing={doSearch} returnKeyType="search" />
        <TouchableOpacity style={s.searchBtn} onPress={doSearch}>
          <Text style={s.searchBtnText}>搜索</Text>
        </TouchableOpacity>
      </View>
      <View style={s.filterRow}>
        {(['all', 'agent', 'human'] as TypeFilter[]).map((filter) => (
          <TouchableOpacity key={filter} style={[s.filterBtn, typeFilter === filter && s.filterBtnActive]} onPress={() => selectFilter(filter)}>
            <Text style={[s.filterText, typeFilter === filter && s.filterTextActive]}>{filter === 'all' ? '全部' : filter === 'agent' ? 'Agent' : '用户'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {capabilityOptions.length > 0 ? (
        <View style={s.capabilityRow}>
          {capabilityOptions.map((capability) => (
            <TouchableOpacity key={capability} style={s.capabilityBtn} onPress={() => selectCapability(capability)}>
              <Text style={s.capabilityText}>{capability}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      <Text style={s.sectionTitle}>{heading}</Text>
      <FlatList data={data} keyExtractor={(i) => i.citizen_id} renderItem={renderItem} keyboardShouldPersistTaps="handled" />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  searchRow: { flexDirection: 'row', padding: 12 },
  searchInput: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#fff' },
  searchBtn: { backgroundColor: '#ff6b35', borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 8 },
  searchBtnText: { color: '#fff', fontWeight: '700' },
  filterRow: { flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 8 },
  filterBtn: { height: 32, minWidth: 64, paddingHorizontal: 12, borderRadius: 16, backgroundColor: '#151515', borderWidth: 1, borderColor: '#2a2a2a', justifyContent: 'center', alignItems: 'center', marginRight: 8 },
  filterBtnActive: { backgroundColor: '#ff6b35', borderColor: '#ff6b35' },
  filterText: { color: '#aaa', fontSize: 13, fontWeight: '700' },
  filterTextActive: { color: '#fff' },
  capabilityRow: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, paddingBottom: 6 },
  capabilityBtn: { backgroundColor: '#112033', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, marginBottom: 8, borderWidth: 1, borderColor: '#1d4b7a' },
  capabilityText: { color: '#8ec5ff', fontSize: 12 },
  sectionTitle: { color: '#888', fontSize: 13, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  agentAvatar: { backgroundColor: '#ff6b35' },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  info: { flex: 1, marginLeft: 12 },
  name: { color: '#fff', fontSize: 16, fontWeight: '600' },
  handle: { color: '#666', fontSize: 12, marginTop: 1 },
  bio: { color: '#888', fontSize: 12, marginTop: 2 },
  species: { color: '#ff6b35', fontSize: 12, marginTop: 2 },
  resultChips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  resultChip: { color: '#8ec5ff', backgroundColor: '#112033', borderRadius: 6, overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 3, fontSize: 11, marginRight: 6, marginBottom: 4 },
  addBtn: { minWidth: 76, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  addText: { color: '#ff6b35', fontSize: 13, fontWeight: '700' },
});
