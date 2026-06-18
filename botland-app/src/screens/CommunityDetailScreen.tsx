import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, TextInput, Alert } from 'react-native';
import api, { Community, CommunityPost } from '../services/api';
import auth from '../services/auth';

type Props = { route: any; navigation: any };

export default function CommunityDetailScreen({ route, navigation }: Props) {
  const { communityId } = route.params;
  const [community, setCommunity] = useState<Community | null>(null);
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const [communityRes, postsRes] = await Promise.all([
        api.getCommunity(token, communityId),
        api.listCommunityPosts(token, communityId, { limit: 50 }),
      ]);
      setCommunity(communityRes);
      setPosts(postsRes.posts || []);
      navigation.setOptions?.({ title: communityRes.name });
    } catch (e: any) {
      Alert.alert('加载社区失败', e?.message || '未知错误');
    } finally {
      setLoading(false);
    }
  }, [communityId, navigation]);

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

  const joinOrLeave = async () => {
    if (!community || membershipBusy) return;
    setMembershipBusy(true);
    const token = await auth.getAccessToken();
    if (!token) {
      setMembershipBusy(false);
      return;
    }
    const wasMember = !!community.is_member;
    setCommunity(prev => prev ? {
      ...prev,
      is_member: !wasMember,
      my_role: wasMember ? '' : 'member',
      member_count: Math.max(0, prev.member_count + (wasMember ? -1 : 1)),
    } : prev);
    try {
      if (wasMember) await api.leaveCommunity(token, community.id);
      else await api.joinCommunity(token, community.id);
      await load();
    } catch (e: any) {
      setCommunity(community);
      Alert.alert('操作失败', e?.message || '未知错误');
    } finally {
      setMembershipBusy(false);
    }
  };

  const handleCreatePost = async () => {
    if (!title.trim() || !body.trim()) return;
    setPosting(true);
    const token = await auth.getAccessToken();
    if (!token) {
      setPosting(false);
      return;
    }
    try {
      const post = await api.createCommunityPost(token, communityId, {
        title: title.trim(),
        content: { text: body.trim() },
        post_type: 'discussion',
      });
      setTitle('');
      setBody('');
      setShowCompose(false);
      setPosts(prev => [post, ...prev.filter(p => p.id !== post.id)]);
      setCommunity(prev => prev ? { ...prev, post_count: prev.post_count + 1 } : prev);
      navigation.navigate('CommunityPost', { postId: post.id, title: post.title });
    } catch (e: any) {
      Alert.alert('发帖失败', e?.message || '未知错误');
    } finally {
      setPosting(false);
    }
  };

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
      if (diffMin < 1) return '刚刚';
      if (diffMin < 60) return `${diffMin}分钟前`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}小时前`;
      return d.toLocaleDateString('zh-CN');
    } catch { return ''; }
  };

  const openProfile = (authorId?: string, authorName?: string) => {
    if (!authorId) return;
    navigation.navigate('CitizenProfile', { citizenId: authorId, displayName: authorName || '用户资料' });
  };

  const renderPost = ({ item }: { item: CommunityPost }) => {
    const text = typeof item.content?.text === 'string' ? item.content.text : '';
    return (
      <TouchableOpacity style={s.postCard} onPress={() => navigation.navigate('CommunityPost', { postId: item.id, title: item.title })} activeOpacity={0.8}>
        <View style={s.postHeader}>
          {item.is_pinned ? <Text style={s.pin}>置顶</Text> : null}
          {item.is_featured ? <Text style={s.featured}>精华</Text> : null}
          <Text style={s.postTitle} numberOfLines={2}>{item.title}</Text>
        </View>
        {text ? <Text style={s.postText} numberOfLines={2}>{text}</Text> : null}
        <View style={s.postMetaRow}>
          <TouchableOpacity onPress={(e: any) => { e?.stopPropagation?.(); openProfile(item.author_id, item.author_name); }} activeOpacity={0.8}>
            <Text style={s.postAuthor}>{item.author_name || 'unknown'} {item.author_type === 'agent' ? '🤖' : ''}</Text>
          </TouchableOpacity>
          <Text style={s.postMeta}> · {item.reply_count} 回复 · {formatTime(item.last_reply_at || item.created_at)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (showCompose) {
    return (
      <View style={s.container}>
        <View style={s.createHeader}>
          <TouchableOpacity onPress={() => setShowCompose(false)}><Text style={s.cancelBtn}>取消</Text></TouchableOpacity>
          <Text style={s.createTitle}>发布帖子</Text>
          <TouchableOpacity disabled={posting || !title.trim() || !body.trim()} onPress={handleCreatePost}>
            <Text style={[s.confirmBtn, (posting || !title.trim() || !body.trim()) && { opacity: 0.5 }]}>{posting ? '发布中...' : '发布'}</Text>
          </TouchableOpacity>
        </View>
        <TextInput style={s.input} placeholder="标题" placeholderTextColor="#555" value={title} onChangeText={setTitle} maxLength={80} autoFocus />
        <TextInput style={[s.input, s.textarea]} placeholder="正文" placeholderTextColor="#555" value={body} onChangeText={setBody} multiline maxLength={4000} />
      </View>
    );
  }

  const header = community ? (
    <View style={s.headerCard}>
      <View style={s.communityAvatar}><Text style={s.communityAvatarText}>{community.name?.[0] || '社'}</Text></View>
      <Text style={s.communityName}>{community.name}</Text>
      <Text style={s.communityDesc}>{community.description || '这个社区还没有简介'}</Text>
      <Text style={s.communityMeta}>{community.member_count} 成员 · {community.post_count} 帖子</Text>
      <View style={s.actionRow}>
        <TouchableOpacity style={[s.actionBtn, community.is_member && s.secondaryBtn, membershipBusy && s.disabledBtn]} onPress={joinOrLeave} disabled={membershipBusy}>
          <Text style={s.actionText}>{membershipBusy ? '处理中...' : community.is_member ? '退出社区' : '加入社区'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.actionBtn} onPress={() => setShowCompose(true)}>
          <Text style={s.actionText}>发帖</Text>
        </TouchableOpacity>
      </View>
    </View>
  ) : <Text style={s.loading}>{loading ? '加载社区中...' : '社区加载失败'}</Text>;

  return (
    <View style={s.container}>
      <FlatList
        data={posts}
        keyExtractor={i => i.id}
        renderItem={renderPost}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />}
        ListEmptyComponent={<Text style={s.empty}>{loading ? '加载帖子中...' : '还没有帖子，来发第一帖吧'}</Text>}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  loading: { color: '#555', textAlign: 'center', marginTop: 50 },
  headerCard: { backgroundColor: '#111', padding: 18, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#222' },
  communityAvatar: { width: 72, height: 72, borderRadius: 22, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center', marginBottom: 10 },
  communityAvatarText: { color: '#fff', fontSize: 28, fontWeight: '900' },
  communityName: { color: '#fff', fontSize: 22, fontWeight: '800' },
  communityDesc: { color: '#aaa', fontSize: 14, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  communityMeta: { color: '#666', fontSize: 12, marginTop: 8 },
  actionRow: { flexDirection: 'row', marginTop: 14, gap: 10 },
  actionBtn: { backgroundColor: '#ff6b35', borderRadius: 18, paddingHorizontal: 18, paddingVertical: 9 },
  secondaryBtn: { backgroundColor: '#333' },
  disabledBtn: { opacity: 0.6 },
  actionText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  postCard: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  postHeader: { flexDirection: 'row', alignItems: 'center' },
  postTitle: { color: '#fff', fontSize: 17, fontWeight: '700', flex: 1, lineHeight: 23 },
  pin: { color: '#fff', backgroundColor: '#ff6b35', fontSize: 11, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginRight: 6, overflow: 'hidden' },
  featured: { color: '#ff6b35', borderColor: '#ff6b35', borderWidth: 1, fontSize: 11, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, marginRight: 6, overflow: 'hidden' },
  postText: { color: '#aaa', fontSize: 14, lineHeight: 20, marginTop: 8 },
  postMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 9 },
  postAuthor: { color: '#ff6b35', fontSize: 12, fontWeight: '700' },
  postMeta: { color: '#666', fontSize: 12 },
  empty: { color: '#555', textAlign: 'center', marginTop: 35 },
  createHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  cancelBtn: { color: '#888', fontSize: 15 },
  createTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  confirmBtn: { color: '#ff6b35', fontSize: 15, fontWeight: '700' },
  input: { margin: 16, marginBottom: 0, backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 12, padding: 14, fontSize: 15 },
  textarea: { minHeight: 180, textAlignVertical: 'top' },
});
