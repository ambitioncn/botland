import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type Member = { citizen_id: string; display_name: string; role: string; avatar_url?: string; citizen_type: string };
type GroupInfo = { id: string; name: string; owner_id: string; description?: string; members: Member[]; member_count: number };
type Props = { route: any; navigation: any };

export default function GroupDetailScreen({ route, navigation }: Props) {
  const { groupId } = route.params;
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [myId, setMyId] = useState('');

  const load = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const [g, me] = await Promise.all([
        api.getGroup(token, groupId),
        api.getMe(token),
      ]);
      setGroup(g as GroupInfo);
      setMyId((me as any).id || (me as any).citizen_id || '');
    } catch {}
  };

  useEffect(() => { load(); }, [groupId]);

  const myRole = group?.members?.find(m => m.citizen_id === myId)?.role || '';
  const isOwner = myRole === 'owner';
  const isAdmin = myRole === 'admin' || isOwner;

  const handleLeave = async () => {
    const doLeave = async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try {
        await api.leaveGroup(token, groupId);
        navigation.goBack();
        navigation.goBack(); // Back to groups list
      } catch (e: any) {
        const msg = e?.message || '操作失败';
        if (typeof window !== 'undefined') window.alert(msg);
      }
    };
    if (typeof window !== 'undefined') {
      if (window.confirm('确定退出群聊？')) doLeave();
    } else {
      Alert.alert('退出群聊', '确定要退出吗？', [
        { text: '取消', style: 'cancel' },
        { text: '退出', style: 'destructive', onPress: doLeave },
      ]);
    }
  };

  const handleDisband = async () => {
    const doDisband = async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try {
        await api.disbandGroup(token, groupId);
        navigation.goBack();
        navigation.goBack();
      } catch (e: any) {
        const msg = e?.message || '操作失败';
        if (typeof window !== 'undefined') window.alert(msg);
      }
    };
    if (typeof window !== 'undefined') {
      if (window.confirm('确定解散群聊？此操作不可恢复！')) doDisband();
    } else {
      Alert.alert('解散群聊', '确定要解散吗？此操作不可恢复！', [
        { text: '取消', style: 'cancel' },
        { text: '解散', style: 'destructive', onPress: doDisband },
      ]);
    }
  };

  const handleKick = async (memberId: string, memberName: string) => {
    const doKick = async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try {
        await api.removeGroupMember(token, groupId, memberId);
        load();
      } catch (e: any) {
        if (typeof window !== 'undefined') window.alert(e?.message || '操作失败');
      }
    };
    if (typeof window !== 'undefined') {
      if (window.confirm(`移除 ${memberName}？`)) doKick();
    } else {
      Alert.alert('移除成员', `确定移除 ${memberName}？`, [
        { text: '取消', style: 'cancel' },
        { text: '移除', style: 'destructive', onPress: doKick },
      ]);
    }
  };

  if (!group) return <View style={s.container}><Text style={s.loading}>加载中...</Text></View>;

  const roleLabel = (r: string) => r === 'owner' ? '群主' : r === 'admin' ? '管理' : '';
  const typeIcon = (t: string) => t === 'agent' ? '🤖' : '';

  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.groupName}>{group.name}</Text>
        {group.description ? <Text style={s.desc}>{group.description}</Text> : null}
        <Text style={s.memberCount}>{group.member_count} 位成员</Text>
      </View>

      <Text style={s.sectionTitle}>群成员</Text>
      <FlatList
        data={group.members}
        keyExtractor={i => i.citizen_id}
        renderItem={({ item }) => (
          <View style={s.memberItem}>
            <View style={[s.memberAvatar, item.citizen_type === 'agent' ? { backgroundColor: '#3b82f6' } : {}]}>
              <Text style={s.memberAvatarText}>{item.display_name?.[0] || '?'}</Text>
            </View>
            <View style={s.memberInfo}>
              <Text style={s.memberName}>
                {typeIcon(item.citizen_type)} {item.display_name}
              </Text>
              {roleLabel(item.role) ? <Text style={s.roleTag}>{roleLabel(item.role)}</Text> : null}
            </View>
            {isAdmin && item.citizen_id !== myId && item.role !== 'owner' && (
              <TouchableOpacity onPress={() => handleKick(item.citizen_id, item.display_name)}>
                <Text style={s.kickBtn}>移除</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      />

      <View style={s.actions}>
        {!isOwner && (
          <TouchableOpacity style={s.leaveBtn} onPress={handleLeave}>
            <Text style={s.leaveBtnText}>退出群聊</Text>
          </TouchableOpacity>
        )}
        {isOwner && (
          <TouchableOpacity style={s.disbandBtn} onPress={handleDisband}>
            <Text style={s.disbandBtnText}>解散群聊</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  loading: { color: '#555', textAlign: 'center', marginTop: 60 },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#222' },
  groupName: { color: '#fff', fontSize: 22, fontWeight: '700' },
  desc: { color: '#888', fontSize: 14, marginTop: 4 },
  memberCount: { color: '#ff6b35', fontSize: 13, marginTop: 8 },
  sectionTitle: { color: '#888', fontSize: 13, padding: 16, paddingBottom: 8, backgroundColor: '#0a0a0a' },
  memberItem: { flexDirection: 'row', alignItems: 'center', padding: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  memberAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  memberAvatarText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  memberInfo: { flex: 1, marginLeft: 12 },
  memberName: { color: '#fff', fontSize: 15, fontWeight: '500' },
  roleTag: { color: '#ff6b35', fontSize: 11, marginTop: 2 },
  kickBtn: { color: '#ff3b30', fontSize: 13, fontWeight: '600', paddingHorizontal: 10 },
  actions: { padding: 20, borderTopWidth: 1, borderTopColor: '#222' },
  leaveBtn: { backgroundColor: '#1a1a1a', padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#ff3b30' },
  leaveBtnText: { color: '#ff3b30', fontSize: 15, fontWeight: '600' },
  disbandBtn: { backgroundColor: '#ff3b30', padding: 14, borderRadius: 10, alignItems: 'center' },
  disbandBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
