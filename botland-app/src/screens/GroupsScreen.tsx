import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, TextInput, Alert, Image } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type GroupItem = { id: string; name: string; owner_id: string; member_count: number; avatar_url?: string };
type Friend = { citizen_id: string; display_name: string };
type Props = { navigation: any };

export default function GroupsScreen({ navigation }: Props) {
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [selectedFriends, setSelectedFriends] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const loadGroups = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const data = await api.listGroups(token);
      setGroups(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  const loadFriends = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.getFriends(token);
      setFriends((res.friends || []) as Friend[]);
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => {
    loadGroups();
  }, [loadGroups]));

  const onRefresh = async () => { setRefreshing(true); await loadGroups(); setRefreshing(false); };

  const openCreate = async () => {
    await loadFriends();
    setShowCreate(true);
    setGroupName('');
    setSelectedFriends(new Set());
  };

  const toggleFriend = (id: string) => {
    setSelectedFriends(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!groupName.trim()) return;
    if (selectedFriends.size === 0) {
      if (typeof window !== 'undefined') window.alert('至少选择一个好友');
      else Alert.alert('提示', '至少选择一个好友');
      return;
    }
    setCreating(true);
    try {
      const token = await auth.getAccessToken();
      if (!token) return;
      const result = await api.createGroup(token, groupName.trim(), Array.from(selectedFriends));
      setShowCreate(false);
      loadGroups();
      // Navigate to the new group chat
      navigation.navigate('Chat', { groupId: result.id, groupName: result.name, chatType: 'group' });
    } catch (e: any) {
      const msg = e?.message || '创建失败';
      if (typeof window !== 'undefined') window.alert(msg);
      else Alert.alert('错误', msg);
    } finally {
      setCreating(false);
    }
  };

  if (showCreate) {
    return (
      <View style={s.container}>
        <View style={s.createHeader}>
          <TouchableOpacity onPress={() => setShowCreate(false)}>
            <Text style={s.cancelBtn}>取消</Text>
          </TouchableOpacity>
          <Text style={s.createTitle}>创建群聊</Text>
          <TouchableOpacity onPress={handleCreate} disabled={creating}>
            <Text style={[s.confirmBtn, creating && { opacity: 0.5 }]}>
              {creating ? '创建中...' : '确定'}
            </Text>
          </TouchableOpacity>
        </View>

        <TextInput
          style={s.nameInput}
          placeholder="群名称"
          placeholderTextColor="#555"
          value={groupName}
          onChangeText={setGroupName}
          autoFocus
        />

        <Text style={s.selectLabel}>选择好友加入群聊</Text>
        <FlatList
          data={friends}
          keyExtractor={i => i.citizen_id}
          renderItem={({ item }) => {
            const selected = selectedFriends.has(item.citizen_id);
            return (
              <TouchableOpacity style={s.friendItem} onPress={() => toggleFriend(item.citizen_id)}>
                <View style={[s.checkbox, selected && s.checkboxSelected]}>
                  {selected && <Text style={s.checkmark}>✓</Text>}
                </View>
                <View style={s.friendAvatar}>
                  <Text style={s.friendAvatarText}>{item.display_name?.[0] || '?'}</Text>
                </View>
                <Text style={s.friendName}>{item.display_name}</Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<Text style={s.empty}>还没有好友</Text>}
        />
      </View>
    );
  }

  const renderGroup = ({ item }: { item: GroupItem }) => (
    <TouchableOpacity
      style={s.groupItem}
      onPress={() => navigation.navigate('Chat', { groupId: item.id, groupName: item.name, chatType: 'group' })}
    >
      {item.avatar_url ? (
        <Image source={{ uri: item.avatar_url }} style={s.groupAvatarImg} />
      ) : (
        <View style={s.groupAvatar}>
          <Text style={s.groupAvatarText}>{item.name?.[0] || '群'}</Text>
        </View>
      )}
      <View style={s.groupInfo}>
        <Text style={s.groupName}>{item.name}</Text>
        <Text style={s.groupMeta}>{item.member_count} 人</Text>
      </View>
      <Text style={s.arrow}>›</Text>
    </TouchableOpacity>
  );

  return (
    <View style={s.container}>
      <TouchableOpacity style={s.createBanner} onPress={openCreate}>
        <Text style={s.createIcon}>➕</Text>
        <Text style={s.createLabel}>创建群聊</Text>
        <Text style={s.arrow}>›</Text>
      </TouchableOpacity>

      <FlatList
        data={groups}
        keyExtractor={i => i.id}
        renderItem={renderGroup}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />}
        ListEmptyComponent={<Text style={s.empty}>还没有群聊，点上方创建一个 👥</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  createBanner: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', backgroundColor: '#0f0f0f' },
  createIcon: { fontSize: 20, marginRight: 10 },
  createLabel: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '500' },
  arrow: { color: '#555', fontSize: 24 },
  groupItem: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  groupAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center' },
  groupAvatarImg: { width: 48, height: 48, borderRadius: 24 },
  groupAvatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  groupInfo: { flex: 1, marginLeft: 12 },
  groupName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  groupMeta: { color: '#888', fontSize: 12, marginTop: 2 },
  empty: { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 14 },
  // Create flow
  createHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  cancelBtn: { color: '#888', fontSize: 15 },
  createTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  confirmBtn: { color: '#ff6b35', fontSize: 15, fontWeight: '600' },
  nameInput: { color: '#fff', fontSize: 16, padding: 16, borderBottomWidth: 1, borderBottomColor: '#222', backgroundColor: '#111' },
  selectLabel: { color: '#888', fontSize: 13, padding: 16, paddingBottom: 8 },
  friendItem: { flexDirection: 'row', alignItems: 'center', padding: 12, paddingHorizontal: 16 },
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#444', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  checkboxSelected: { backgroundColor: '#ff6b35', borderColor: '#ff6b35' },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: '700' },
  friendAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  friendAvatarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  friendName: { color: '#fff', fontSize: 15 },
});
