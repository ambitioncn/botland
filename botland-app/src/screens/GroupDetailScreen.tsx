import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, TextInput, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import auth from '../services/auth';

type Member = { citizen_id: string; display_name: string; role: string; avatar_url?: string; citizen_type: string };
type GroupInfo = { id: string; name: string; owner_id: string; description?: string; avatar_url?: string; members: Member[]; member_count: number };
type Props = { route: any; navigation: any };

export default function GroupDetailScreen({ route, navigation }: Props) {
  const { groupId } = route.params;
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [myId, setMyId] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [uploading, setUploading] = useState(false);

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

  // --- Edit Group Name ---
  const startEditName = () => {
    setNewName(group?.name || '');
    setEditingName(true);
  };

  const submitName = async () => {
    if (!newName.trim() || newName.trim() === group?.name) {
      setEditingName(false);
      return;
    }
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.updateGroup(token, groupId, { name: newName.trim() });
      setEditingName(false);
      load();
    } catch (e: any) {
      const msg = e?.message || '修改失败';
      if (typeof window !== 'undefined') window.alert(msg);
      else Alert.alert('错误', msg);
    }
  };

  // --- Change Group Avatar ---
  const pickAvatar = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;

    setUploading(true);
    const token = await auth.getAccessToken();
    if (!token) { setUploading(false); return; }
    try {
      const upload = await api.uploadImage(token, result.assets[0].uri, 'avatars');
      await api.updateGroup(token, groupId, { avatar_url: upload.url });
      load();
    } catch (e: any) {
      const msg = e?.message || '上传失败';
      if (typeof window !== 'undefined') window.alert(msg);
      else Alert.alert('错误', msg);
    } finally { setUploading(false); }
  };

  // --- Leave / Disband / Kick ---
  const confirm = (title: string, msg: string, action: () => void) => {
    if (typeof window !== 'undefined') {
      if (window.confirm(`${title}\n${msg}`)) action();
    } else {
      Alert.alert(title, msg, [
        { text: '取消', style: 'cancel' },
        { text: '确定', style: 'destructive', onPress: action },
      ]);
    }
  };

  const handleLeave = () => confirm('退出群聊', '确定要退出吗？', async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try { await api.leaveGroup(token, groupId); navigation.goBack(); navigation.goBack(); }
    catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); }
  });

  const handleDisband = () => confirm('解散群聊', '确定要解散吗？此操作不可恢复！', async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try { await api.disbandGroup(token, groupId); navigation.goBack(); navigation.goBack(); }
    catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); }
  });

  const handleKick = (memberId: string, memberName: string) =>
    confirm('移除成员', `确定移除 ${memberName}？`, async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try { await api.removeGroupMember(token, groupId, memberId); load(); }
      catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); }
    });

  if (!group) return <View style={s.container}><Text style={s.loading}>加载中...</Text></View>;

  const roleLabel = (r: string) => r === 'owner' ? '群主' : r === 'admin' ? '管理' : '';
  const typeIcon = (t: string) => t === 'agent' ? '🤖' : '';

  return (
    <View style={s.container}>
      {/* Header with avatar + name */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.avatarWrap}
          onPress={isAdmin ? pickAvatar : undefined}
          disabled={!isAdmin || uploading}
          activeOpacity={isAdmin ? 0.7 : 1}
        >
          {group.avatar_url ? (
            <Image source={{ uri: group.avatar_url }} style={s.avatarImg} />
          ) : (
            <View style={s.avatarFallback}>
              <Text style={s.avatarFallbackText}>{group.name?.[0] || '群'}</Text>
            </View>
          )}
          {isAdmin && (
            <View style={s.avatarBadge}>
              <Text style={s.avatarBadgeText}>{uploading ? '...' : '📷'}</Text>
            </View>
          )}
        </TouchableOpacity>

        <View style={s.headerInfo}>
          {editingName ? (
            <View style={s.editNameRow}>
              <TextInput
                style={s.editNameInput}
                value={newName}
                onChangeText={setNewName}
                autoFocus
                onSubmitEditing={submitName}
                returnKeyType="done"
                placeholderTextColor="#555"
              />
              <TouchableOpacity onPress={submitName}><Text style={s.editNameSave}>保存</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setEditingName(false)}><Text style={s.editNameCancel}>取消</Text></TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={isAdmin ? startEditName : undefined} activeOpacity={isAdmin ? 0.7 : 1}>
              <View style={s.nameRow}>
                <Text style={s.groupName}>{group.name}</Text>
                {isAdmin && <Text style={s.editIcon}>✏️</Text>}
              </View>
            </TouchableOpacity>
          )}
          {group.description ? <Text style={s.desc}>{group.description}</Text> : null}
          <Text style={s.memberCount}>{group.member_count} 位成员</Text>
        </View>
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

  // Header
  header: { flexDirection: 'row', padding: 20, borderBottomWidth: 1, borderBottomColor: '#222', alignItems: 'center' },
  avatarWrap: { position: 'relative', marginRight: 16 },
  avatarImg: { width: 64, height: 64, borderRadius: 32 },
  avatarFallback: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center' },
  avatarFallbackText: { color: '#fff', fontSize: 28, fontWeight: '700' },
  avatarBadge: { position: 'absolute', bottom: -2, right: -2, backgroundColor: '#222', borderRadius: 10, width: 20, height: 20, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#0a0a0a' },
  avatarBadgeText: { fontSize: 10 },
  headerInfo: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  groupName: { color: '#fff', fontSize: 22, fontWeight: '700' },
  editIcon: { marginLeft: 8, fontSize: 14 },
  desc: { color: '#888', fontSize: 14, marginTop: 4 },
  memberCount: { color: '#ff6b35', fontSize: 13, marginTop: 8 },

  // Edit name
  editNameRow: { flexDirection: 'row', alignItems: 'center' },
  editNameInput: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '600', borderBottomWidth: 1, borderBottomColor: '#ff6b35', paddingVertical: 4 },
  editNameSave: { color: '#ff6b35', fontSize: 14, fontWeight: '600', marginLeft: 12 },
  editNameCancel: { color: '#888', fontSize: 14, marginLeft: 8 },

  // Members
  sectionTitle: { color: '#888', fontSize: 13, padding: 16, paddingBottom: 8, backgroundColor: '#0a0a0a' },
  memberItem: { flexDirection: 'row', alignItems: 'center', padding: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  memberAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  memberAvatarText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  memberInfo: { flex: 1, marginLeft: 12 },
  memberName: { color: '#fff', fontSize: 15, fontWeight: '500' },
  roleTag: { color: '#ff6b35', fontSize: 11, marginTop: 2 },
  kickBtn: { color: '#ff3b30', fontSize: 13, fontWeight: '600', paddingHorizontal: 10 },

  // Actions
  actions: { padding: 20, borderTopWidth: 1, borderTopColor: '#222' },
  leaveBtn: { backgroundColor: '#1a1a1a', padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#ff3b30' },
  leaveBtnText: { color: '#ff3b30', fontSize: 15, fontWeight: '600' },
  disbandBtn: { backgroundColor: '#ff3b30', padding: 14, borderRadius: 10, alignItems: 'center' },
  disbandBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
