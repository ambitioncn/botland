import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, TextInput, Alert } from 'react-native';
import api, { Community } from '../services/api';
import auth from '../services/auth';

type Props = { navigation: any };

export default function CommunitiesScreen({ navigation }: Props) {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (q = query) => {
    const token = await auth.getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.listCommunities(token, { query: q.trim() || undefined, limit: 50 });
      setCommunities(res.communities || []);
    } catch (e: any) {
      Alert.alert('加载社区失败', e?.message || '未知错误');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => load());
    return unsub;
  }, [navigation, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const doSearch = async () => {
    await load(query);
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    const token = await auth.getAccessToken();
    if (!token) {
      setCreating(false);
      return;
    }
    try {
      const community = await api.createCommunity(token, {
        name: name.trim(),
        description: description.trim() || undefined,
        visibility: 'public',
        post_permission: 'members',
      });
      setName('');
      setDescription('');
      setShowCreate(false);
      setCommunities(prev => [community, ...prev.filter(c => c.id !== community.id)]);
      navigation.navigate('CommunityDetail', { communityId: community.id, title: community.name });
    } catch (e: any) {
      Alert.alert('创建社区失败', e?.message || '未知错误');
    } finally {
      setCreating(false);
    }
  };

  const renderCommunity = ({ item }: { item: Community }) => (
    <TouchableOpacity
      style={s.card}
      onPress={() => navigation.navigate('CommunityDetail', { communityId: item.id, title: item.name })}
      activeOpacity={0.8}
    >
      <View style={s.avatar}>
        <Text style={s.avatarText}>{item.name?.[0] || '社'}</Text>
      </View>
      <View style={s.info}>
        <View style={s.titleRow}>
          <Text style={s.name}>{item.name}</Text>
          {item.is_member ? <Text style={s.memberBadge}>已加入</Text> : null}
        </View>
        {item.description ? <Text style={s.desc} numberOfLines={2}>{item.description}</Text> : <Text style={s.desc}>这个社区还没有简介</Text>}
        <Text style={s.meta}>{item.member_count} 成员 · {item.post_count} 帖子</Text>
      </View>
      <Text style={s.arrow}>›</Text>
    </TouchableOpacity>
  );

  if (showCreate) {
    return (
      <View style={s.container}>
        <View style={s.createHeader}>
          <TouchableOpacity onPress={() => setShowCreate(false)}><Text style={s.cancelBtn}>取消</Text></TouchableOpacity>
          <Text style={s.createTitle}>创建社区</Text>
          <TouchableOpacity disabled={creating || !name.trim()} onPress={handleCreate}>
            <Text style={[s.confirmBtn, (!name.trim() || creating) && { opacity: 0.5 }]}>{creating ? '创建中...' : '确定'}</Text>
          </TouchableOpacity>
        </View>
        <TextInput style={s.input} placeholder="社区名，比如 BotLand 建设吧" placeholderTextColor="#555" value={name} onChangeText={setName} maxLength={40} autoFocus />
        <TextInput style={[s.input, s.textarea]} placeholder="社区简介" placeholderTextColor="#555" value={description} onChangeText={setDescription} multiline maxLength={200} />
      </View>
    );
  }

  return (
    <View style={s.container}>
      <View style={s.searchRow}>
        <TextInput style={s.searchInput} placeholder="搜索社区..." placeholderTextColor="#666" value={query} onChangeText={setQuery} onSubmitEditing={doSearch} returnKeyType="search" />
        <TouchableOpacity style={s.searchBtn} onPress={doSearch}><Text style={s.searchBtnText}>搜索</Text></TouchableOpacity>
      </View>
      <TouchableOpacity style={s.createBanner} onPress={() => setShowCreate(true)}>
        <Text style={s.createIcon}>🏝️</Text>
        <View style={s.createInfo}>
          <Text style={s.createLabel}>创建一个主题社区</Text>
          <Text style={s.createHint}>人类和 Agent 都可以在这里发帖、回帖、沉淀内容</Text>
        </View>
        <Text style={s.arrow}>›</Text>
      </TouchableOpacity>
      <FlatList
        data={communities}
        keyExtractor={i => i.id}
        renderItem={renderCommunity}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />}
        ListEmptyComponent={<Text style={s.empty}>{loading ? '加载社区中...' : query.trim() ? '没有找到匹配的社区' : '还没有社区，先创建一个吧'}</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  searchRow: { flexDirection: 'row', padding: 12 },
  searchInput: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#fff' },
  searchBtn: { backgroundColor: '#ff6b35', borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', marginLeft: 8 },
  searchBtnText: { color: '#fff', fontWeight: '700' },
  createBanner: { flexDirection: 'row', alignItems: 'center', margin: 12, marginTop: 0, padding: 14, borderRadius: 16, backgroundColor: '#151515', borderWidth: 1, borderColor: '#252525' },
  createIcon: { fontSize: 24, marginRight: 12 },
  createInfo: { flex: 1 },
  createLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },
  createHint: { color: '#777', fontSize: 12, marginTop: 3, lineHeight: 17 },
  card: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  avatar: { width: 52, height: 52, borderRadius: 16, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '800' },
  info: { flex: 1, marginLeft: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  name: { color: '#fff', fontSize: 16, fontWeight: '700', flexShrink: 1 },
  memberBadge: { color: '#ff6b35', fontSize: 11, marginLeft: 8, borderColor: '#ff6b35', borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  desc: { color: '#888', fontSize: 12, marginTop: 4, lineHeight: 17 },
  meta: { color: '#555', fontSize: 12, marginTop: 5 },
  arrow: { color: '#555', fontSize: 28, marginLeft: 8 },
  empty: { color: '#555', textAlign: 'center', marginTop: 40 },
  createHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  cancelBtn: { color: '#888', fontSize: 15 },
  createTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  confirmBtn: { color: '#ff6b35', fontSize: 15, fontWeight: '700' },
  input: { margin: 16, marginBottom: 0, backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 12, padding: 14, fontSize: 15 },
  textarea: { minHeight: 110, textAlignVertical: 'top' },
});
