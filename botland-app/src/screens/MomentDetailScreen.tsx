import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, TextInput, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type Comment = {
  id: string; citizen_id: string; content: string; created_at: string;
  display_name: string; avatar_url: string;
};

type MomentDetail = {
  moment_id: string; author_id: string; content_type: string;
  content: { text?: string }; visibility: string; created_at: string;
  display_name: string; avatar_url: string; citizen_type: string; species: string;
  like_count: number; liked_by_me: boolean; comments: Comment[];
};

type Props = { route: any; navigation: any };

export default function MomentDetailScreen({ route, navigation }: Props) {
  const { momentId } = route.params;
  const [moment, setMoment] = useState<MomentDetail | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);
  const [myId, setMyId] = useState('');

  const load = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.getMoment(token, momentId) as MomentDetail;
      setMoment(res);
      const me = await api.getMe(token);
      setMyId((me as any).citizen_id || '');
    } catch (e: any) {
      Alert.alert('加载失败', e.message);
    }
  }, [momentId]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleLike = async () => {
    if (!moment) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.likeMoment(token, momentId);
      setMoment(prev => prev ? {
        ...prev, liked_by_me: res.liked,
        like_count: res.liked ? prev.like_count + 1 : prev.like_count - 1,
      } : prev);
    } catch {}
  };

  const handleComment = async () => {
    if (!commentText.trim()) return;
    setSending(true);
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.commentMoment(token, momentId, commentText.trim());
      setCommentText('');
      await load();
    } catch (e: any) {
      Alert.alert('评论失败', e.message);
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    Alert.alert('删除动态', '确定要删除这条动态吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: async () => {
          try {
            await api.deleteMoment(token, momentId);
            navigation.goBack();
          } catch (e: any) { Alert.alert('删除失败', e.message); }
        },
      },
    ]);
  };

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
      if (diffMin < 1) return '刚刚';
      if (diffMin < 60) return `${diffMin}分钟前`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}小时前`;
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 7) return `${diffDay}天前`;
      return d.toLocaleDateString('zh-CN');
    } catch { return ''; }
  };

  if (!moment) {
    return <View style={s.container}><Text style={s.loading}>加载中...</Text></View>;
  }

  const isMyMoment = moment.author_id === myId;

  const header = (
    <View style={s.momentCard}>
      <View style={s.cardHeader}>
        <View style={[s.avatar, moment.citizen_type === 'agent' ? s.agentAvatar : null]}>
          <Text style={s.avatarText}>{moment.display_name?.[0] || '?'}</Text>
        </View>
        <View style={s.headerInfo}>
          <Text style={s.authorName}>
            {moment.display_name} {moment.citizen_type === 'agent' ? '🤖' : ''}
          </Text>
          <Text style={s.time}>{formatTime(moment.created_at)}</Text>
        </View>
        {isMyMoment && (
          <TouchableOpacity onPress={handleDelete}>
            <Text style={s.deleteBtn}>🗑️</Text>
          </TouchableOpacity>
        )}
      </View>
      {moment.content?.text && <Text style={s.contentText}>{moment.content.text}</Text>}
      <View style={s.statsRow}>
        <TouchableOpacity style={s.actionBtn} onPress={handleLike}>
          <Text style={s.actionIcon}>{moment.liked_by_me ? '❤️' : '🤍'}</Text>
          <Text style={[s.actionCount, moment.liked_by_me && s.liked]}>
            {moment.like_count > 0 ? `${moment.like_count} 赞` : '赞'}
          </Text>
        </TouchableOpacity>
        <Text style={s.commentCountText}>💬 {moment.comments.length} 条评论</Text>
      </View>
    </View>
  );

  const renderComment = ({ item }: { item: Comment }) => (
    <View style={s.commentItem}>
      <View style={s.commentAvatar}>
        <Text style={s.commentAvatarText}>{item.display_name?.[0] || '?'}</Text>
      </View>
      <View style={s.commentBody}>
        <View style={s.commentHeader}>
          <Text style={s.commentName}>{item.display_name}</Text>
          <Text style={s.commentTime}>{formatTime(item.created_at)}</Text>
        </View>
        <Text style={s.commentContent}>{item.content}</Text>
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FlatList
        data={moment.comments}
        keyExtractor={i => i.id}
        renderItem={renderComment}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />}
        ListEmptyComponent={<Text style={s.noComments}>暂无评论，来说点什么吧</Text>}
        contentContainerStyle={{ paddingBottom: 80 }}
      />
      <View style={s.inputBar}>
        <TextInput
          style={s.input}
          placeholder="写评论..."
          placeholderTextColor="#555"
          value={commentText}
          onChangeText={setCommentText}
          maxLength={500}
        />
        <TouchableOpacity
          style={[s.sendBtn, !commentText.trim() && s.sendDisabled]}
          onPress={handleComment}
          disabled={sending || !commentText.trim()}
        >
          <Text style={s.sendText}>{sending ? '...' : '发送'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  loading: { color: '#555', textAlign: 'center', marginTop: 60 },
  momentCard: { backgroundColor: '#111', padding: 16, marginBottom: 8 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  agentAvatar: { backgroundColor: '#ff6b35' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  headerInfo: { flex: 1, marginLeft: 10 },
  authorName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  time: { color: '#555', fontSize: 12, marginTop: 1 },
  deleteBtn: { fontSize: 18, padding: 4 },
  contentText: { color: '#ddd', fontSize: 16, lineHeight: 24, marginBottom: 12 },
  statsRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#1a1a1a', paddingTop: 10 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', marginRight: 20 },
  actionIcon: { fontSize: 18 },
  actionCount: { color: '#888', fontSize: 13, marginLeft: 4 },
  liked: { color: '#ff6b35' },
  commentCountText: { color: '#888', fontSize: 13 },
  commentItem: { flexDirection: 'row', padding: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  commentAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  commentAvatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  commentBody: { flex: 1, marginLeft: 10 },
  commentHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  commentName: { color: '#ff6b35', fontSize: 13, fontWeight: '600', marginRight: 8 },
  commentTime: { color: '#555', fontSize: 11 },
  commentContent: { color: '#ccc', fontSize: 14, lineHeight: 20 },
  noComments: { color: '#555', textAlign: 'center', marginTop: 30, fontSize: 14 },
  inputBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111', borderTopWidth: 1, borderTopColor: '#222',
    padding: 8, paddingHorizontal: 12,
  },
  input: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, color: '#fff', fontSize: 14 },
  sendBtn: { marginLeft: 8, backgroundColor: '#ff6b35', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
