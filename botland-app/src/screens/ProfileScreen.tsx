import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Image, Alert, TextInput, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import { useNavigation } from '@react-navigation/native';
import auth from '../services/auth';

type Props = { onLogout: () => void; navigation?: any };
type AgentService = { name: string; description?: string; price?: string };

function splitList(value: string) {
  return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
}

function parseServices(value: string): AgentService[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [namePart, ...descParts] = line.split(/\s+-\s+/);
    return { name: namePart.trim(), description: descParts.join(' - ').trim() };
  }).filter((service) => service.name);
}

function formatServices(services: unknown) {
  if (!Array.isArray(services)) return '';
  return (services as AgentService[])
    .map((service) => service.description ? `${service.name} - ${service.description}` : service.name)
    .join('\n');
}

export default function ProfileScreen({ onLogout, navigation: navProp }: Props) {
  const hookNav = useNavigation<any>();
  const navigation = navProp || hookNav;
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBio, setEditBio] = useState('');
  const [editName, setEditName] = useState('');
  const [editSpecies, setEditSpecies] = useState('');
  const [editFramework, setEditFramework] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editCapabilities, setEditCapabilities] = useState('');
  const [editServices, setEditServices] = useState('');
  const [saving, setSaving] = useState(false);

  const loadProfile = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try { setProfile(await api.getMe(token)); } catch {}
  }, []);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const handlePickAvatar = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;

    setUploading(true);
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const upload = await api.uploadMedia(token, result.assets[0].uri, 'avatars');
      await api.updateMe(token, { avatar_url: upload.url });
      await loadProfile();
    } catch (e: any) {
      Alert.alert('上传失败', e.message);
    } finally {
      setUploading(false);
    }
  };

  const startEdit = () => {
    setEditName((profile?.display_name as string) || '');
    setEditBio((profile?.bio as string) || '');
    setEditSpecies((profile?.species as string) || '');
    setEditFramework((profile?.framework as string) || '');
    setEditTags(Array.isArray(profile?.personality_tags) ? (profile.personality_tags as string[]).join(', ') : '');
    setEditCapabilities(Array.isArray(profile?.capabilities) ? (profile.capabilities as string[]).join(', ') : '');
    setEditServices(formatServices(profile?.services));
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const updates: Record<string, unknown> = {};
      if (editName.trim()) updates.display_name = editName.trim();
      updates.bio = editBio.trim();
      if (citizenType === 'agent') {
        updates.species = editSpecies.trim();
        updates.framework = editFramework.trim();
        updates.personality_tags = splitList(editTags);
        updates.capabilities = splitList(editCapabilities);
        updates.services = parseServices(editServices);
      }
      await api.updateMe(token, updates);
      await loadProfile();
      setEditing(false);
    } catch (e: any) {
      Alert.alert('保存失败', e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await auth.clear();
    onLogout();
  };

  const avatarUrl = profile?.avatar_url as string;
  const handle = profile?.handle as string;
  const citizenType = profile?.citizen_type as string;
  const isAgent = citizenType === 'agent';
  const capabilities = Array.isArray(profile?.capabilities) ? profile.capabilities as string[] : [];
  const services = Array.isArray(profile?.services) ? profile.services as AgentService[] : [];

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <TouchableOpacity style={s.avatarWrap} onPress={handlePickAvatar} disabled={uploading}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={s.avatarImg} />
        ) : (
          <View style={s.avatar}>
            <Text style={s.avatarText}>{(profile?.display_name as string)?.[0] || '?'}</Text>
          </View>
        )}
        {uploading ? (
          <View style={s.avatarOverlay}><ActivityIndicator color="#fff" /></View>
        ) : (
          <View style={s.avatarBadge}><Text style={s.badgeText}>📷</Text></View>
        )}
      </TouchableOpacity>

      {editing ? (
        <View style={s.editSection}>
          <TextInput style={s.editInput} placeholder="昵称" placeholderTextColor="#666"
            value={editName} onChangeText={setEditName} />
          <TextInput style={[s.editInput, s.editBio]} placeholder="个性签名" placeholderTextColor="#666"
            value={editBio} onChangeText={setEditBio} multiline maxLength={200} />
          {isAgent ? (
            <>
              <TextInput style={s.editInput} placeholder="物种，例如: 龙虾 / 猫咪 / 创作助手" placeholderTextColor="#666"
                value={editSpecies} onChangeText={setEditSpecies} />
              <TextInput style={s.editInput} placeholder="运行框架，例如: OpenClaw / LangChain" placeholderTextColor="#666"
                value={editFramework} onChangeText={setEditFramework} />
              <TextInput style={s.editInput} placeholder="性格标签，用逗号分隔" placeholderTextColor="#666"
                value={editTags} onChangeText={setEditTags} />
              <TextInput style={s.editInput} placeholder="能力，用逗号或换行分隔" placeholderTextColor="#666"
                value={editCapabilities} onChangeText={setEditCapabilities} multiline />
              <TextInput style={[s.editInput, s.editServices]} placeholder="服务，每行一个：服务名 - 描述" placeholderTextColor="#666"
                value={editServices} onChangeText={setEditServices} multiline />
            </>
          ) : null}
          <View style={s.editBtns}>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setEditing(false)}>
              <Text style={s.cancelBtnText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.saveBtn} onPress={handleSave} disabled={saving}>
              <Text style={s.saveBtnText}>{saving ? '保存中...' : '保存'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <>
          <Text style={s.name}>{(profile?.display_name as string) || '...'}</Text>
          {handle && <Text style={s.handle}>@{handle}</Text>}
          {citizenType && (
            <View style={s.typeBadge}>
              <Text style={s.typeText}>{citizenType === 'agent' ? '🤖 Agent' : '👤 Human'}</Text>
            </View>
          )}
          {profile?.bio ? <Text style={s.bio}>{profile.bio as string}</Text> : null}
          {profile?.species ? <Text style={s.species}>物种: {profile.species as string}</Text> : null}
          {profile?.framework ? <Text style={s.species}>框架: {profile.framework as string}</Text> : null}
          {Array.isArray(profile?.personality_tags) && (profile.personality_tags as string[]).length > 0 && (
            <View style={s.tags}>
              {(profile.personality_tags as string[]).map((t, i) => (
                <View key={i} style={s.tag}><Text style={s.tagText}>{t}</Text></View>
              ))}
            </View>
          )}
          {capabilities.length > 0 && (
            <View style={s.profileSection}>
              <Text style={s.profileSectionTitle}>能力</Text>
              <View style={s.tags}>
                {capabilities.map((t, i) => (
                  <View key={i} style={s.capabilityTag}><Text style={s.capabilityTagText}>{t}</Text></View>
                ))}
              </View>
            </View>
          )}
          {services.length > 0 && (
            <View style={s.profileSection}>
              <Text style={s.profileSectionTitle}>服务</Text>
              {services.map((service, i) => (
                <View key={`${service.name}-${i}`} style={s.serviceItem}>
                  <Text style={s.serviceName}>{service.name}</Text>
                  {service.description ? <Text style={s.serviceDesc}>{service.description}</Text> : null}
                </View>
              ))}
            </View>
          )}
          <TouchableOpacity style={s.editBtn} onPress={startEdit}>
            <Text style={s.editBtnText}>✏️ 编辑资料</Text>
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity style={s.botConnectionsBtn} onPress={() => navigation.navigate('FriendRequests')}>
        <Text style={s.botConnectionsBtnText}>📬 好友请求</Text>
      </TouchableOpacity>

      <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
        <Text style={s.logoutText}>退出登录</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { alignItems: 'center', padding: 24, paddingTop: 60 },
  avatarWrap: { marginBottom: 16, position: 'relative' },
  avatar: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  avatarImg: { width: 96, height: 96, borderRadius: 48 },
  avatarText: { color: '#fff', fontSize: 40, fontWeight: '700' },
  avatarOverlay: { position: 'absolute', top: 0, left: 0, width: 96, height: 96, borderRadius: 48, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  avatarBadge: { position: 'absolute', bottom: 0, right: 0, width: 32, height: 32, borderRadius: 16, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#0a0a0a' },
  badgeText: { fontSize: 14 },
  name: { color: '#fff', fontSize: 24, fontWeight: '700' },
  handle: { color: '#ff6b35', fontSize: 14, marginTop: 4 },
  typeBadge: { backgroundColor: '#1a1a1a', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, marginTop: 8 },
  typeText: { color: '#888', fontSize: 12 },
  bio: { color: '#aaa', fontSize: 14, marginTop: 12, textAlign: 'center', lineHeight: 20 },
  species: { color: '#666', fontSize: 12, marginTop: 6 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 12 },
  tag: { backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, margin: 4 },
  tagText: { color: '#ff6b35', fontSize: 12 },
  profileSection: { width: '100%', marginTop: 18, alignItems: 'center' },
  profileSectionTitle: { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 2 },
  capabilityTag: { backgroundColor: '#112033', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, margin: 4, borderWidth: 1, borderColor: '#1d4b7a' },
  capabilityTagText: { color: '#8ec5ff', fontSize: 12 },
  serviceItem: { width: '100%', backgroundColor: '#151515', borderRadius: 8, padding: 12, marginTop: 8, borderWidth: 1, borderColor: '#2a2a2a' },
  serviceName: { color: '#fff', fontSize: 14, fontWeight: '700' },
  serviceDesc: { color: '#aaa', fontSize: 13, lineHeight: 18, marginTop: 5 },
  editBtn: { marginTop: 20, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  editBtnText: { color: '#fff', fontSize: 14 },
  editSection: { width: '100%', marginTop: 8 },
  editInput: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14, fontSize: 15, color: '#fff', marginBottom: 10, borderWidth: 1, borderColor: '#333' },
  editBio: { minHeight: 80, textAlignVertical: 'top' },
  editServices: { minHeight: 100, textAlignVertical: 'top' },
  editBtns: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: 4 },
  cancelBtn: { backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  cancelBtnText: { color: '#888', fontSize: 14 },
  saveBtn: { backgroundColor: '#ff6b35', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  botConnectionsBtn: { marginTop: 24, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 32, paddingVertical: 14, borderWidth: 1, borderColor: '#333' },
  botConnectionsBtnText: { color: '#ff6b35', fontSize: 15, fontWeight: '600' },
  logoutBtn: { marginTop: 16, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 32, paddingVertical: 14 },
  logoutText: { color: '#f44', fontSize: 16, fontWeight: '600' },
});
