import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator, Alert, ScrollView } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type Props = { route: any; navigation: any };
type AgentService = { name: string; description?: string; price?: string };
type Citizen = {
  citizen_id: string;
  handle: string;
  display_name: string;
  avatar_url?: string;
  bio?: string;
  species?: string;
  framework?: string;
  citizen_type: string;
  status?: string;
  personality_tags?: string[];
  capabilities?: string[];
  services?: AgentService[];
  stats?: { friend_count?: number; group_count?: number; moment_count?: number };
};

export default function CitizenProfileScreen({ route, navigation }: Props) {
  const { citizenId, displayName } = route.params || {};
  const [citizen, setCitizen] = useState<Citizen | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    navigation.setOptions({ title: displayName || '用户资料' });
    (async () => {
      const token = await auth.getAccessToken();
      if (!token) { setLoading(false); return; }
      try {
        const c = await api.getCitizen(token, citizenId);
        setCitizen(c as unknown as Citizen);
      } catch {}
      setLoading(false);
    })();
  }, [citizenId]);

  if (loading) return <View style={s.container}><ActivityIndicator color="#ff6b35" style={{ marginTop: 60 }} /></View>;
  if (!citizen) return <View style={s.container}><Text style={s.empty}>无法加载用户资料</Text></View>;

  const isAgent = citizen.citizen_type === 'agent';
  const capabilities = Array.isArray(citizen.capabilities) ? citizen.capabilities : [];
  const tags = Array.isArray(citizen.personality_tags) ? citizen.personality_tags : [];
  const services = Array.isArray(citizen.services) ? citizen.services : [];
  const stats = citizen.stats || {};

  const handleAddFriend = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.sendFriendRequest(token, citizen.citizen_id, '你好，想和你成为好友。');
      Alert.alert('已发送好友请求');
    } catch (e: any) {
      Alert.alert('发送失败', e?.message || '发送好友请求失败');
    }
  };

  const openChat = (draftText?: string) => {
    navigation.navigate('Chat', {
      friendId: citizen.citizen_id,
      friendName: citizen.display_name,
      draftText,
    });
  };

  const startServiceChat = (service: AgentService) => {
    const lines = [
      `我想咨询你的服务：${service.name}`,
      service.description ? `服务说明：${service.description}` : '',
      service.price ? `价格：${service.price}` : '',
    ].filter(Boolean);
    openChat(lines.join('\n'));
  };

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <View style={s.card}>
        {citizen.avatar_url ? (
          <Image source={{ uri: citizen.avatar_url }} style={s.avatar} />
        ) : (
          <View style={[s.avatarFallback, isAgent && { backgroundColor: '#3b82f6' }]}>
            <Text style={s.avatarText}>{(citizen.display_name || '?')[0]}</Text>
          </View>
        )}
        <Text style={s.name}>{isAgent ? '🤖 ' : ''}{citizen.display_name}</Text>
        <Text style={s.handle}>@{citizen.handle}</Text>
        {citizen.bio ? <Text style={s.bio}>{citizen.bio}</Text> : null}
        <Text style={s.type}>{isAgent ? 'Bot' : '用户'}</Text>
        {isAgent ? (
          <View style={s.metaGrid}>
            <View style={s.metaItem}><Text style={s.metaValue}>{citizen.species || '未设置'}</Text><Text style={s.metaLabel}>物种</Text></View>
            <View style={s.metaItem}><Text style={s.metaValue}>{citizen.framework || '未知'}</Text><Text style={s.metaLabel}>框架</Text></View>
            <View style={s.metaItem}><Text style={s.metaValue}>{stats.friend_count ?? 0}</Text><Text style={s.metaLabel}>好友</Text></View>
          </View>
        ) : null}
      </View>

      {tags.length > 0 ? (
        <View style={s.section}>
          <Text style={s.sectionTitle}>性格标签</Text>
          <View style={s.chips}>
            {tags.map((tag, index) => (
              <View key={`${tag}-${index}`} style={s.chip}><Text style={s.chipText}>{tag}</Text></View>
            ))}
          </View>
        </View>
      ) : null}

      {capabilities.length > 0 ? (
        <View style={s.section}>
          <Text style={s.sectionTitle}>能力</Text>
          <View style={s.chips}>
            {capabilities.map((capability, index) => (
              <View key={`${capability}-${index}`} style={s.capabilityChip}><Text style={s.capabilityText}>{capability}</Text></View>
            ))}
          </View>
        </View>
      ) : null}

      {services.length > 0 ? (
        <View style={s.section}>
          <Text style={s.sectionTitle}>服务</Text>
          {services.map((service, index) => (
            <TouchableOpacity key={`${service.name}-${index}`} style={s.serviceItem} activeOpacity={0.85} onPress={() => startServiceChat(service)}>
              <View style={s.serviceHeader}>
                <Text style={s.serviceName}>{service.name}</Text>
                <Text style={s.serviceAction}>咨询</Text>
              </View>
              {service.description ? <Text style={s.serviceDesc}>{service.description}</Text> : null}
              {service.price ? <Text style={s.servicePrice}>{service.price}</Text> : null}
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      <TouchableOpacity style={s.addBtn} onPress={handleAddFriend}>
        <Text style={s.addBtnText}>加好友</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.chatBtn} onPress={() => {
        openChat();
      }}>
        <Text style={s.chatBtnText}>直接发消息</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { paddingBottom: 28 },
  empty: { color: '#555', textAlign: 'center', marginTop: 60 },
  card: { alignItems: 'center', padding: 30, borderBottomWidth: 1, borderBottomColor: '#222' },
  avatar: { width: 80, height: 80, borderRadius: 40 },
  avatarFallback: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontSize: 36, fontWeight: '700' },
  name: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 14 },
  handle: { color: '#888', fontSize: 14, marginTop: 4 },
  bio: { color: '#aaa', fontSize: 14, marginTop: 10, textAlign: 'center', paddingHorizontal: 20 },
  type: { color: '#ff6b35', fontSize: 12, marginTop: 8 },
  metaGrid: { flexDirection: 'row', marginTop: 18, borderWidth: 1, borderColor: '#242424', borderRadius: 8, overflow: 'hidden' },
  metaItem: { minWidth: 84, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center', borderRightWidth: 1, borderRightColor: '#242424' },
  metaValue: { color: '#fff', fontSize: 13, fontWeight: '700' },
  metaLabel: { color: '#666', fontSize: 11, marginTop: 4 },
  section: { paddingHorizontal: 20, paddingTop: 20 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { backgroundColor: '#151515', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, marginBottom: 8, borderWidth: 1, borderColor: '#2a2a2a' },
  chipText: { color: '#ff6b35', fontSize: 12 },
  capabilityChip: { backgroundColor: '#112033', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, marginBottom: 8, borderWidth: 1, borderColor: '#1d4b7a' },
  capabilityText: { color: '#8ec5ff', fontSize: 12 },
  serviceItem: { backgroundColor: '#151515', borderRadius: 8, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#2a2a2a' },
  serviceHeader: { flexDirection: 'row', alignItems: 'center' },
  serviceName: { color: '#fff', fontSize: 15, fontWeight: '700', flex: 1 },
  serviceAction: { color: '#8ec5ff', fontSize: 12, fontWeight: '700', marginLeft: 10 },
  serviceDesc: { color: '#aaa', fontSize: 13, lineHeight: 18, marginTop: 6 },
  servicePrice: { color: '#ff6b35', fontSize: 12, fontWeight: '700', marginTop: 8 },
  addBtn: { backgroundColor: '#1a1a1a', marginHorizontal: 20, marginTop: 20, padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  addBtnText: { color: '#ff6b35', fontSize: 16, fontWeight: '600' },
  chatBtn: { backgroundColor: '#ff6b35', margin: 20, padding: 14, borderRadius: 10, alignItems: 'center' },
  chatBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
