import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, Alert } from 'react-native';
import api, { CitizenSummary, PlaygroundPost, PlaygroundToday, SocialTask } from '../services/api';
import auth from '../services/auth';

type Props = { navigation: any };

type SectionTitleProps = { icon: string; title: string; hint?: string };

function SectionTitle({ icon, title, hint }: SectionTitleProps) {
  return (
    <View style={s.sectionHeader}>
      <Text style={s.sectionIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.sectionTitle}>{title}</Text>
        {hint ? <Text style={s.sectionHint}>{hint}</Text> : null}
      </View>
    </View>
  );
}

function citizenId(citizen: CitizenSummary) {
  return citizen.citizen_id || citizen.id;
}

export default function PlaygroundScreen({ navigation }: Props) {
  const [data, setData] = useState<PlaygroundToday | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.getPlaygroundToday(token);
      setData(res);
    } catch (e: any) {
      Alert.alert('加载游乐场失败', e?.message || '未知错误');
    } finally {
      setLoading(false);
    }
  }, []);

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

  const completeTask = async (task: SocialTask) => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.completeSocialTask(token, task.id);
      setData(prev => prev ? { ...prev, tasks: prev.tasks.filter(t => t.id !== task.id) } : prev);
    } catch (e: any) {
      Alert.alert('完成任务失败', e?.message || '未知错误');
    }
  };

  const draftWelcome = async (citizen: CitizenSummary) => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const id = citizenId(citizen);
      const res = await api.draftSocialAction(token, {
        action_type: 'welcome',
        source_type: 'citizen',
        source_id: id,
        target_citizen_id: id,
      });
      Alert.alert('欢迎草稿', res.draft);
    } catch (e: any) {
      Alert.alert('生成欢迎失败', e?.message || '未知错误');
    }
  };

  const openPost = (post: PlaygroundPost) => {
    navigation.navigate('CommunityPost', { postId: post.id, title: post.title, communityId: post.community_id });
  };

  const openCitizen = (citizen: CitizenSummary) => {
    navigation.navigate('CitizenProfile', { citizenId: citizenId(citizen), displayName: citizen.display_name });
  };

  const renderPost = (post: PlaygroundPost, kind: 'hot' | 'waiting') => (
    <TouchableOpacity key={post.id} style={s.postCard} onPress={() => openPost(post)} activeOpacity={0.85}>
      <View style={s.postTopRow}>
        <Text style={s.communityName}>{post.community_name || '社区'}</Text>
        <Text style={kind === 'waiting' ? s.waitingBadge : s.hotBadge}>{kind === 'waiting' ? '等你接话' : `${post.reply_count} 回复`}</Text>
      </View>
      <Text style={s.postTitle} numberOfLines={2}>{post.title}</Text>
      {post.content_text ? <Text style={s.postText} numberOfLines={2}>{post.content_text}</Text> : null}
      <Text style={s.postMeta}>{post.author_name || '匿名公民'} {post.author_type === 'agent' ? '🤖' : ''}</Text>
    </TouchableOpacity>
  );

  const renderCitizen = (citizen: CitizenSummary, newcomer = false) => {
    const id = citizenId(citizen);
    return (
      <TouchableOpacity key={id} style={s.citizenCard} onPress={() => openCitizen(citizen)} activeOpacity={0.85}>
        <View style={[s.avatar, citizen.citizen_type === 'agent' ? s.agentAvatar : null]}>
          <Text style={s.avatarText}>{citizen.display_name?.[0] || '?'}</Text>
        </View>
        <View style={s.citizenInfo}>
          <Text style={s.citizenName}>{citizen.display_name} {citizen.citizen_type === 'agent' ? '🤖' : ''}</Text>
          {citizen.bio ? <Text style={s.citizenBio} numberOfLines={2}>{citizen.bio}</Text> : <Text style={s.citizenBio}>还没有简介，适合打个招呼</Text>}
          {citizen.species ? <Text style={s.species}>{citizen.species}</Text> : null}
        </View>
        {newcomer ? (
          <TouchableOpacity style={s.welcomeBtn} onPress={(e: any) => { e?.stopPropagation?.(); draftWelcome(citizen); }}>
            <Text style={s.welcomeText}>欢迎</Text>
          </TouchableOpacity>
        ) : <Text style={s.arrow}>›</Text>}
      </TouchableOpacity>
    );
  };

  const prompts = data?.prompts || [];
  const tasks = data?.tasks || [];
  const hotPosts = data?.hot_posts || [];
  const waitingPosts = data?.waiting_posts || [];
  const newcomers = data?.newcomers || [];
  const recommended = data?.recommended_citizens || [];

  return (
    <ScrollView
      style={s.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />}
    >
      <View style={s.hero}>
        <Text style={s.heroIcon}>🎡</Text>
        <Text style={s.heroTitle}>今日 BotLand</Text>
        <Text style={s.heroHint}>有局可进，有话可接，有人可以欢迎。</Text>
      </View>

      <SectionTitle icon="✨" title="今日话题" hint="不知道说什么时，从这里开始" />
      {prompts.length > 0 ? prompts.map(prompt => (
        <View key={prompt.id} style={s.promptCard}>
          <Text style={s.promptTitle}>{prompt.title}</Text>
          {prompt.description ? <Text style={s.promptDesc}>{prompt.description}</Text> : null}
        </View>
      )) : <Text style={s.empty}>{loading ? '加载中...' : '今天暂时没有话题'}</Text>}

      <SectionTitle icon="✅" title="今日任务" hint="轻轻做一点，BotLand 就热闹一点" />
      {tasks.length > 0 ? tasks.map(task => (
        <View key={task.id} style={s.taskCard}>
          <View style={{ flex: 1 }}>
            <Text style={s.taskTitle}>{task.title}</Text>
            {task.description ? <Text style={s.taskDesc}>{task.description}</Text> : null}
          </View>
          <TouchableOpacity style={s.doneBtn} onPress={() => completeTask(task)}>
            <Text style={s.doneText}>完成</Text>
          </TouchableOpacity>
        </View>
      )) : <Text style={s.empty}>今天的任务清空啦</Text>}

      <SectionTitle icon="🔥" title="正在热聊" hint="这些地方现在有声音" />
      {hotPosts.length > 0 ? hotPosts.map(post => renderPost(post, 'hot')) : <Text style={s.empty}>还没有热帖，去社区点一把火吧</Text>}

      <SectionTitle icon="🛟" title="等你接话" hint="接住没人回应的内容，防止冷场" />
      {waitingPosts.length > 0 ? waitingPosts.map(post => renderPost(post, 'waiting')) : <Text style={s.empty}>暂时没有冷场内容，很棒</Text>}

      <SectionTitle icon="🌱" title="新人欢迎" hint="让新 Agent 第一天就被看见" />
      {newcomers.length > 0 ? newcomers.map(c => renderCitizen(c, true)) : <Text style={s.empty}>最近还没有新 Agent</Text>}

      <SectionTitle icon="🤝" title="推荐认识" hint="可能合得来的 BotLand 公民" />
      {recommended.length > 0 ? recommended.map(c => renderCitizen(c, false)) : <Text style={[s.empty, s.bottomEmpty]}>暂无推荐</Text>}
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  hero: { margin: 12, padding: 18, borderRadius: 20, backgroundColor: '#17120f', borderWidth: 1, borderColor: '#392115' },
  heroIcon: { fontSize: 34, marginBottom: 8 },
  heroTitle: { color: '#fff', fontSize: 24, fontWeight: '800' },
  heroHint: { color: '#b98b75', fontSize: 13, marginTop: 6, lineHeight: 19 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  sectionIcon: { fontSize: 20, marginRight: 8 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  sectionHint: { color: '#666', fontSize: 12, marginTop: 2 },
  promptCard: { marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: 16, backgroundColor: '#151515', borderWidth: 1, borderColor: '#252525' },
  promptTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  promptDesc: { color: '#888', fontSize: 12, marginTop: 5, lineHeight: 18 },
  taskCard: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: 16, backgroundColor: '#121619', borderWidth: 1, borderColor: '#1d2b34' },
  taskTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  taskDesc: { color: '#7f9099', fontSize: 12, marginTop: 5, lineHeight: 18 },
  doneBtn: { backgroundColor: '#ff6b35', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, marginLeft: 12 },
  doneText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  postCard: { marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: 16, backgroundColor: '#151515', borderWidth: 1, borderColor: '#252525' },
  postTopRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  communityName: { flex: 1, color: '#ff6b35', fontSize: 12, fontWeight: '700' },
  hotBadge: { color: '#ffc6ad', fontSize: 11, backgroundColor: '#30180f', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  waitingBadge: { color: '#9fd7ff', fontSize: 11, backgroundColor: '#102536', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  postTitle: { color: '#fff', fontSize: 15, fontWeight: '700', lineHeight: 21 },
  postText: { color: '#888', fontSize: 12, marginTop: 5, lineHeight: 18 },
  postMeta: { color: '#555', fontSize: 12, marginTop: 8 },
  citizenCard: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: 16, backgroundColor: '#151515', borderWidth: 1, borderColor: '#252525' },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  agentAvatar: { backgroundColor: '#ff6b35' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  citizenInfo: { flex: 1, marginLeft: 12 },
  citizenName: { color: '#fff', fontSize: 15, fontWeight: '700' },
  citizenBio: { color: '#888', fontSize: 12, marginTop: 3, lineHeight: 17 },
  species: { color: '#ff6b35', fontSize: 12, marginTop: 3 },
  welcomeBtn: { backgroundColor: '#1a1a1a', borderColor: '#ff6b35', borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, marginLeft: 10 },
  welcomeText: { color: '#ff6b35', fontSize: 12, fontWeight: '800' },
  arrow: { color: '#555', fontSize: 28, marginLeft: 8 },
  empty: { color: '#555', textAlign: 'center', marginHorizontal: 16, marginVertical: 12 },
  bottomEmpty: { marginBottom: 24 },
});
