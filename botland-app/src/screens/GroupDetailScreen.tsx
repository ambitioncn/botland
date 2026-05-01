import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, TextInput, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import auth from '../services/auth';

type Member = { citizen_id: string; display_name: string; role: string; avatar_url?: string; citizen_type: string };
type GroupInfo = { id: string; name: string; owner_id: string; description?: string; announcement?: string; muted_all?: boolean; avatar_url?: string; members: Member[]; member_count: number };
type Props = { route: any; navigation: any };

export default function GroupDetailScreen({ route, navigation }: Props) {
  const { groupId } = route.params;
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [groupUnavailableHandled, setGroupUnavailableHandled] = useState(false);
  const [myId, setMyId] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [newDesc, setNewDesc] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState(false);
  const [newAnnouncement, setNewAnnouncement] = useState('');
  const [friends, setFriends] = useState<{citizen_id:string;display_name:string}[]>([]);
  const [selectedInvite, setSelectedInvite] = useState<Set<string>>(new Set());
  const [inviting, setInviting] = useState(false);

  const handleGroupUnavailable = (message?: string) => {
    if (groupUnavailableHandled) return;
    setGroupUnavailableHandled(true);
    const text = message || '该群聊已不可访问，正在返回群列表';
    if (typeof window !== 'undefined') window.alert(text);
    else Alert.alert('群聊不可用', text);
    if ((navigation as any).replace) (navigation as any).replace('Groups');
    else {
      navigation.goBack?.();
      navigation.goBack?.();
    }
  };

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
    } catch (e: any) {
      const msg = e?.message || '';
      if (msg.includes('not a member') || msg.includes('group not found')) {
        handleGroupUnavailable('该群聊详情已不可访问，正在返回群列表');
      }
    }
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

  const startEditDesc = () => { setNewDesc(group?.description || ''); setEditingDesc(true); };
  const startEditAnnouncement = () => { setNewAnnouncement(group?.announcement || ''); setEditingAnnouncement(true); };
  const submitAnnouncement = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.updateGroup(token, groupId, { announcement: newAnnouncement.trim() });
      setEditingAnnouncement(false); load();
    } catch (e: any) {
      const msg = e?.message || '修改失败';
      if (typeof window !== 'undefined') window.alert(msg); else Alert.alert('错误', msg);
    }
  };

  const submitDesc = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.updateGroup(token, groupId, { description: newDesc.trim() });
      setEditingDesc(false); load();
    } catch (e: any) {
      const msg = e?.message || '修改失败';
      if (typeof window !== 'undefined') window.alert(msg); else Alert.alert('错误', msg);
    }
  };

  const openInvite = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.getFriends(token);
      const memberIds = new Set(group?.members?.map(m => m.citizen_id) || []);
      setFriends(((res as any).friends || []).filter((f: any) => !memberIds.has(f.citizen_id)));
      setSelectedInvite(new Set());
      setShowInvite(true);
    } catch {}
  };

  const toggleInvite = (id: string) => {
    setSelectedInvite(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const doInvite = async () => {
    if (selectedInvite.size === 0) return;
    setInviting(true);
    const token = await auth.getAccessToken();
    if (!token) { setInviting(false); return; }
    try {
      await api.inviteGroupMembers(token, groupId, Array.from(selectedInvite));
      setShowInvite(false); load();
    } catch (e: any) {
      if (typeof window !== 'undefined') window.alert(e?.message || '邀请失败');
    } finally { setInviting(false); }
  };

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
      const upload = await api.uploadMedia(token, result.assets[0].uri, 'avatars');
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
    try {
      await api.leaveGroup(token, groupId);
      if (typeof window !== 'undefined') window.alert('你已退出该群聊');
      else Alert.alert('已退出群聊');
      navigation.goBack();
      navigation.goBack();
    }
    catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); else Alert.alert('错误', e?.message || '操作失败'); }
  });

  const handleDisband = () => confirm('解散群聊', '确定要解散吗？此操作不可恢复！', async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.disbandGroup(token, groupId);
      if (typeof window !== 'undefined') window.alert('群聊已解散');
      else Alert.alert('群聊已解散');
      navigation.goBack();
      navigation.goBack();
    }
    catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); else Alert.alert('错误', e?.message || '操作失败'); }
  });

  const handleKick = (memberId: string, memberName: string) =>
    confirm('移除成员', `确定移除 ${memberName}？`, async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try { await api.removeGroupMember(token, groupId, memberId); load(); }
      catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); }
    });

  const handleToggleAdmin = (memberId: string, memberName: string, makeAdmin: boolean) =>
    confirm(makeAdmin ? '设为管理员' : '取消管理员', `${makeAdmin ? '确定将' : '确定取消'} ${memberName} ${makeAdmin ? '设为' : '的'}管理员？`, async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try { await api.updateGroupMemberRole(token, groupId, memberId, makeAdmin ? 'admin' : 'member'); load(); }
      catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); }
    });

  const handleTransferOwnership = (memberId: string, memberName: string) =>
    confirm('转让群主', `确定将群主转让给 ${memberName}？`, async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try { await api.transferGroupOwnership(token, groupId, memberId); load(); }
      catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); }
    });

  const handleToggleMuteAll = async () => {
    const token = await auth.getAccessToken();
    if (!token || !group) return;
    try { await api.toggleGroupMuteAll(token, groupId, !group.muted_all); load(); }
    catch (e: any) { if (typeof window !== 'undefined') window.alert(e?.message || '操作失败'); }
  };


  if (showInvite) {
    return (
      <View style={s.container}>
        <View style={s.inviteHeader}>
          <TouchableOpacity onPress={() => setShowInvite(false)}><Text style={s.inviteCancel}>取消</Text></TouchableOpacity>
          <Text style={s.inviteTitle}>邀请好友</Text>
          <TouchableOpacity onPress={doInvite} disabled={inviting || selectedInvite.size === 0}>
            <Text style={[s.inviteConfirm, (inviting || selectedInvite.size === 0) && { opacity: 0.4 }]}>{inviting ? '邀请中...' : `邀请(${selectedInvite.size})`}</Text>
          </TouchableOpacity>
        </View>
        <FlatList data={friends} keyExtractor={i => i.citizen_id} renderItem={({ item }) => {
          const sel = selectedInvite.has(item.citizen_id);
          return (
            <TouchableOpacity style={s.inviteItem} onPress={() => toggleInvite(item.citizen_id)}>
              <View style={[s.inviteCheck, sel && s.inviteCheckSel]}>{sel && <Text style={s.inviteCheckMark}>✓</Text>}</View>
              <View style={s.inviteAvatar}><Text style={s.inviteAvatarText}>{item.display_name?.[0] || '?'}</Text></View>
              <Text style={s.inviteName}>{item.display_name}</Text>
            </TouchableOpacity>
          );
        }} ListEmptyComponent={<Text style={s.emptyInvite}>没有更多好友可邀请</Text>} />
      </View>
    );
  }

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
          {editingDesc ? (
            <View style={s.editNameRow}>
              <TextInput style={[s.editNameInput, { fontSize: 14 }]} value={newDesc} onChangeText={setNewDesc} autoFocus onSubmitEditing={submitDesc} returnKeyType="done" placeholder="添加群简介..." placeholderTextColor="#555" multiline />
              <TouchableOpacity onPress={submitDesc}><Text style={s.editNameSave}>保存</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setEditingDesc(false)}><Text style={s.editNameCancel}>取消</Text></TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={isAdmin ? startEditDesc : undefined} activeOpacity={isAdmin ? 0.7 : 1}>
              <Text style={s.desc}>{group.description || (isAdmin ? '点击添加群简介...' : '')}</Text>
            </TouchableOpacity>
          )}
          <Text style={s.memberCount}>{group.member_count} 位成员</Text>
          {editingAnnouncement ? (
            <View style={s.editNameRow}>
              <TextInput style={[s.editNameInput, { fontSize: 14 }]} value={newAnnouncement} onChangeText={setNewAnnouncement} autoFocus onSubmitEditing={submitAnnouncement} returnKeyType="done" placeholder="添加群公告..." placeholderTextColor="#555" multiline />
              <TouchableOpacity onPress={submitAnnouncement}><Text style={s.editNameSave}>保存</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setEditingAnnouncement(false)}><Text style={s.editNameCancel}>取消</Text></TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={isAdmin ? startEditAnnouncement : undefined} activeOpacity={isAdmin ? 0.7 : 1}>
              <Text style={s.announcement}>{group.announcement || (isAdmin ? '点击添加群公告...' : '')}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.muteAllBtn} onPress={handleToggleMuteAll}>
            <Text style={s.muteAllBtnText}>{group.muted_all ? '关闭全员禁言' : '开启全员禁言'}</Text>
          </TouchableOpacity>

        </View>
      </View>

      <TouchableOpacity style={s.inviteBtn} onPress={openInvite}>
        <Text style={s.inviteBtnIcon}>➕</Text>
        <Text style={s.inviteBtnText}>邀请好友</Text>
      </TouchableOpacity>
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
            {isOwner && item.citizen_id !== myId && item.role !== 'owner' && (
              <>
                <TouchableOpacity onPress={() => handleToggleAdmin(item.citizen_id, item.display_name, item.role !== 'admin')}>
                  <Text style={s.adminBtn}>{item.role === 'admin' ? '取消管理' : '设管理'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleTransferOwnership(item.citizen_id, item.display_name)}>
                  <Text style={s.transferBtn}>转群主</Text>
                </TouchableOpacity>
              </>
            )}
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
  announcement: { color: '#ffd166', fontSize: 13, marginTop: 6 },
  muteAllBtn: { marginTop: 10, alignSelf: 'flex-start', backgroundColor: '#1a1a1a', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#333' },
  muteAllBtnText: { color: '#9ec5ff', fontSize: 12, fontWeight: '600' },

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
  adminBtn: { color: '#4f8cff', fontSize: 13, fontWeight: '600', paddingHorizontal: 10 },
  transferBtn: { color: '#ffd166', fontSize: 13, fontWeight: '600', paddingHorizontal: 10 },

  // Actions
  actions: { padding: 20, borderTopWidth: 1, borderTopColor: '#222' },
  leaveBtn: { backgroundColor: '#1a1a1a', padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#ff3b30' },
  leaveBtnText: { color: '#ff3b30', fontSize: 15, fontWeight: '600' },
  disbandBtn: { backgroundColor: '#ff3b30', padding: 14, borderRadius: 10, alignItems: 'center' },
  disbandBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // Invite
  inviteBtn: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', backgroundColor: '#0f0f0f' },
  inviteBtnIcon: { fontSize: 18, marginRight: 10 },
  inviteBtnText: { color: '#ff6b35', fontSize: 15, fontWeight: '500' },
  inviteHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  inviteCancel: { color: '#888', fontSize: 15 },
  inviteTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  inviteConfirm: { color: '#ff6b35', fontSize: 15, fontWeight: '600' },
  inviteItem: { flexDirection: 'row', alignItems: 'center', padding: 12, paddingHorizontal: 16 },
  inviteCheck: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#444', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  inviteCheckSel: { backgroundColor: '#ff6b35', borderColor: '#ff6b35' },
  inviteCheckMark: { color: '#fff', fontSize: 14, fontWeight: '700' },
  inviteAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  inviteAvatarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  inviteName: { color: '#fff', fontSize: 15 },
  emptyInvite: { color: '#555', textAlign: 'center', marginTop: 40, fontSize: 14 },
});
