import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet, RefreshControl, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import api, { CommunityPost, CommunityReply } from '../services/api';
import auth from '../services/auth';
import SocialActionBar from '../components/SocialActionBar';

type Props = { route: any; navigation: any };

export default function CommunityPostScreen({ route, navigation }: Props) {
  const { postId } = route.params;
  const [post, setPost] = useState<CommunityPost | null>(null);
  const [replies, setReplies] = useState<CommunityReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const [postRes, repliesRes] = await Promise.all([
        api.getCommunityPost(token, postId),
        api.listCommunityReplies(token, postId, { limit: 100 }),
      ]);
      setPost(postRes);
      setReplies(repliesRes.replies || []);
      navigation.setOptions?.({ title: postRes.title });
    } catch (e: any) {
      Alert.alert('加载帖子失败', e?.message || '未知错误');
    } finally {
      setLoading(false);
    }
  }, [postId, navigation]);

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

  const sendReply = async () => {
    if (!replyText.trim()) return;
    setSending(true);
    const token = await auth.getAccessToken();
    if (!token) {
      setSending(false);
      return;
    }
    try {
      const text = replyText.trim();
      setReplyText('');
      setPost(prev => prev ? { ...prev, reply_count: prev.reply_count + 1 } : prev);
      await api.createCommunityReply(token, postId, { content: { text } });
      await load();
    } catch (e: any) {
      setReplyText(prev => prev || replyText.trim());
      setPost(prev => prev ? { ...prev, reply_count: Math.max(0, prev.reply_count - 1) } : prev);
      Alert.alert('回复失败', e?.message || '未知错误');
    } finally {
      setSending(false);
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

  const applyDraft = (draft: string) => {
    setReplyText(draft);
  };

  const postText = typeof post?.content?.text === 'string' ? post.content.text : '';
  const header = post ? (
    <View style={s.postCard}>
      <Text style={s.title}>{post.title}</Text>
      <TouchableOpacity style={s.authorRow} onPress={() => openProfile(post.author_id, post.author_name)} activeOpacity={0.8}>
        <View style={[s.avatar, post.author_type === 'agent' && s.agentAvatar]}>
          <Text style={s.avatarText}>{post.author_name?.[0] || '?'}</Text>
        </View>
        <View style={s.authorInfo}>
          <Text style={s.authorName}>{post.author_name || 'unknown'} {post.author_type === 'agent' ? '🤖' : ''}</Text>
          <Text style={s.time}>点头像/用户名查看资料 · {formatTime(post.created_at)}</Text>
        </View>
      </TouchableOpacity>
      {postText ? <Text style={s.content}>{postText}</Text> : null}
      <Text style={s.replyCount}>💬 {post.reply_count} 回复</Text>
      <SocialActionBar
        sourceType="community_post"
        sourceId={post.id}
        targetCitizenId={post.author_id}
        actions={['praise', 'question', 'comfort', 'joke', 'invite']}
        onDraft={applyDraft}
      />
    </View>
  ) : <Text style={s.loading}>{loading ? '加载帖子中...' : '帖子加载失败'}</Text>;

  const renderReply = ({ item }: { item: CommunityReply }) => {
    const text = typeof item.content?.text === 'string' ? item.content.text : '';
    return (
      <View style={s.replyItem}>
        <View style={s.replyHeader}>
          <TouchableOpacity style={s.replyAuthorTap} onPress={() => openProfile(item.author_id, item.author_name)} activeOpacity={0.8}>
            <View style={[s.replyAvatar, item.author_type === 'agent' && s.agentAvatar]}>
              <Text style={s.replyAvatarText}>{item.author_name?.[0] || '?'}</Text>
            </View>
            <View style={s.replyAuthorInfo}>
              <Text style={s.replyName}>{item.author_name || 'unknown'} {item.author_type === 'agent' ? '🤖' : ''}</Text>
              <Text style={s.replyTime}>{formatTime(item.created_at)}</Text>
            </View>
          </TouchableOpacity>
          <Text style={s.floor}>#{item.floor_no}</Text>
        </View>
        <Text style={s.replyText}>{text}</Text>
        <View style={s.replyActions}>
          <SocialActionBar
            sourceType="community_reply"
            sourceId={item.id}
            targetCitizenId={item.author_id}
            actions={['praise', 'question', 'joke']}
            compact
            onDraft={applyDraft}
          />
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FlatList
        data={replies}
        keyExtractor={i => i.id}
        renderItem={renderReply}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />}
        ListEmptyComponent={<Text style={s.empty}>{loading ? '加载回复中...' : '还没有回复，抢个沙发吧'}</Text>}
        contentContainerStyle={{ paddingBottom: 82 }}
      />
      <View style={s.inputBar}>
        <TextInput style={s.input} placeholder="回复这个帖子..." placeholderTextColor="#555" value={replyText} onChangeText={setReplyText} maxLength={1000} />
        <TouchableOpacity style={[s.sendBtn, (!replyText.trim() || sending) && s.sendDisabled]} disabled={!replyText.trim() || sending} onPress={sendReply}>
          <Text style={s.sendText}>{sending ? '...' : '发送'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  loading: { color: '#555', textAlign: 'center', marginTop: 50 },
  postCard: { backgroundColor: '#111', padding: 18, borderBottomWidth: 1, borderBottomColor: '#222' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', lineHeight: 30 },
  authorRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  agentAvatar: { backgroundColor: '#ff6b35' },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  authorInfo: { marginLeft: 10, flex: 1 },
  authorName: { color: '#fff', fontSize: 15, fontWeight: '700' },
  time: { color: '#666', fontSize: 12, marginTop: 2 },
  content: { color: '#ddd', fontSize: 16, lineHeight: 25, marginTop: 16 },
  replyCount: { color: '#888', fontSize: 13, marginTop: 16 },
  replyItem: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  replyHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  replyAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  replyAvatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  replyAuthorTap: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  replyAuthorInfo: { flex: 1, marginLeft: 9 },
  replyName: { color: '#ff6b35', fontSize: 13, fontWeight: '700' },
  replyTime: { color: '#555', fontSize: 11, marginTop: 1 },
  floor: { color: '#666', fontSize: 12 },
  replyText: { color: '#ccc', fontSize: 15, lineHeight: 22, marginLeft: 43 },
  replyActions: { marginLeft: 43, marginTop: 10 },
  empty: { color: '#555', textAlign: 'center', marginTop: 30 },
  inputBar: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', backgroundColor: '#111', borderTopWidth: 1, borderTopColor: '#222', padding: 8, paddingHorizontal: 12 },
  input: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, color: '#fff', fontSize: 14 },
  sendBtn: { marginLeft: 8, backgroundColor: '#ff6b35', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
