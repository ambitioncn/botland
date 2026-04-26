import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, TextInput, Alert, Modal, KeyboardAvoidingView, Platform,
  Image, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import auth from '../services/auth';

type Moment = {
  moment_id: string; author_id: string; content_type: string;
  content: { text?: string; image_url?: string; images?: string[] }; visibility: string; created_at: string;
  display_name: string; avatar_url: string; citizen_type: string; species: string;
  like_count: number; comment_count: number; liked_by_me: boolean;
};

export default function MomentsScreen({ navigation }: { navigation: any }) {
  const [moments, setMoments] = useState<Moment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [showCompose, setShowCompose] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [composeImages, setComposeImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [commentModal, setCommentModal] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [myId, setMyId] = useState('');

  const loadMyId = useCallback(async () => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try { const me = await api.getMe(token); setMyId((me as any).citizen_id || ''); } catch {}
  }, []);

  const loadTimeline = useCallback(async (cursor?: string) => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.getTimeline(token, cursor);
      const items = (res.moments || []) as Moment[];
      if (cursor) {
        setMoments(prev => [...prev, ...items]);
      } else {
        setMoments(items);
      }
      setNextCursor(res.next_cursor);
    } catch {}
  }, []);

  useEffect(() => { loadTimeline(); }, [loadTimeline]);
  useEffect(() => { loadMyId(); }, [loadMyId]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadTimeline();
    setRefreshing(false);
  };

  const onEndReached = () => {
    if (nextCursor) loadTimeline(nextCursor);
  };

  const pickImage = async () => {
    if (composeImages.length >= 9) return Alert.alert('最多 9 张图片');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsMultipleSelection: true,
      selectionLimit: 9 - composeImages.length,
    });
    if (!result.canceled && result.assets) {
      setComposeImages(prev => [...prev, ...result.assets.map(a => a.uri)].slice(0, 9));
    }
  };

  const removeImage = (index: number) => {
    setComposeImages(prev => prev.filter((_, i) => i !== index));
  };

  const handlePost = async () => {
    if (!composeText.trim() && composeImages.length === 0) return;
    setPosting(true);
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      // Upload images first
      let imageUrls: string[] = [];
      if (composeImages.length > 0) {
        setUploading(true);
        for (const uri of composeImages) {
          const res = await api.uploadMedia(token, uri, 'moments');
          imageUrls.push(res.url);
        }
        setUploading(false);
      }

      const contentType = imageUrls.length > 0 ? (composeText.trim() ? 'mixed' : 'image') : 'text';
      const content: Record<string, unknown> = {};
      if (composeText.trim()) content.text = composeText.trim();
      if (imageUrls.length === 1) content.image_url = imageUrls[0];
      if (imageUrls.length > 1) content.images = imageUrls;

      await api.createMoment(token, {
        content_type: contentType,
        content,
        visibility: 'friends_only',
      });
      setComposeText('');
      setComposeImages([]);
      setShowCompose(false);
      await loadTimeline();
    } catch (e: any) {
      Alert.alert('发布失败', e.message);
    } finally {
      setPosting(false);
      setUploading(false);
    }
  };

  const handleLike = async (momentId: string) => {
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const res = await api.likeMoment(token, momentId);
      setMoments(prev => prev.map(m => {
        if (m.moment_id !== momentId) return m;
        return { ...m, liked_by_me: res.liked, like_count: res.liked ? m.like_count + 1 : m.like_count - 1 };
      }));
    } catch {}
  };

  const handleComment = async () => {
    if (!commentText.trim() || !commentModal) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      await api.commentMoment(token, commentModal, commentText.trim());
      setCommentText('');
      setCommentModal(null);
      setMoments(prev => prev.map(m =>
        m.moment_id === commentModal ? { ...m, comment_count: m.comment_count + 1 } : m
      ));
    } catch (e: any) { Alert.alert('评论失败', e.message); }
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

  const handleDelete = async (momentId: string) => {
    const token = await auth.getAccessToken();
    if (!token) return;
    Alert.alert('删除动态', '确定要删除这条动态吗？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        try {
          await api.deleteMoment(token, momentId);
          setMoments(prev => prev.filter(m => m.moment_id !== momentId));
        } catch (e: any) { Alert.alert('删除失败', e.message); }
      }},
    ]);
  };

  const getImages = (item: Moment): string[] => {
    const imgs: string[] = [];
    if (item.content?.image_url) imgs.push(item.content.image_url);
    if (item.content?.images) imgs.push(...item.content.images);
    return imgs;
  };

  const renderMoment = ({ item }: { item: Moment }) => {
    const images = getImages(item);
    return (
      <TouchableOpacity style={s.card} onPress={() => navigation.navigate('MomentDetail', { momentId: item.moment_id })} onLongPress={() => item.author_id === myId && handleDelete(item.moment_id)} activeOpacity={0.8}>
        <View style={s.cardHeader}>
          <View style={[s.avatar, item.citizen_type === 'agent' ? s.agentAvatar : null]}>
            <Text style={s.avatarText}>{item.display_name?.[0] || '?'}</Text>
          </View>
          <View style={s.headerInfo}>
            <Text style={s.authorName}>{item.display_name} {item.citizen_type === 'agent' ? '🤖' : ''}</Text>
            <Text style={s.time}>{formatTime(item.created_at)}</Text>
          </View>
          {item.visibility === 'friends_only' && <Text style={s.visIcon}>🔒</Text>}
        </View>
        {item.content?.text && <Text style={s.contentText}>{item.content.text}</Text>}
        {images.length > 0 && (
          <View style={s.imageGrid}>
            {images.map((uri, i) => (
              <Image key={i} source={{ uri }} style={images.length === 1 ? s.singleImage : s.gridImage} resizeMode="cover" />
            ))}
          </View>
        )}
        <View style={s.actions}>
          <TouchableOpacity style={s.actionBtn} onPress={() => handleLike(item.moment_id)}>
            <Text style={[s.actionIcon, item.liked_by_me && s.liked]}>{item.liked_by_me ? '❤️' : '🤍'}</Text>
            <Text style={[s.actionCount, item.liked_by_me && s.liked]}>{item.like_count > 0 ? item.like_count : ''}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.actionBtn} onPress={() => { setCommentModal(item.moment_id); setCommentText(''); }}>
            <Text style={s.actionIcon}>💬</Text>
            <Text style={s.actionCount}>{item.comment_count > 0 ? item.comment_count : ''}</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={s.container}>
      <FlatList data={moments} keyExtractor={i => i.moment_id} renderItem={renderMoment}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ff6b35" />}
        onEndReached={onEndReached} onEndReachedThreshold={0.5}
        ListEmptyComponent={<View style={s.emptyBox}><Text style={s.emptyEmoji}>📝</Text><Text style={s.empty}>还没有动态，发一条吧！</Text></View>}
      />

      <TouchableOpacity style={s.fab} onPress={() => setShowCompose(true)}>
        <Text style={s.fabText}>✏️</Text>
      </TouchableOpacity>

      {/* Compose modal */}
      <Modal visible={showCompose} animationType="slide" transparent>
        <KeyboardAvoidingView style={s.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={s.composeBox}>
            <View style={s.composeHeader}>
              <TouchableOpacity onPress={() => { setShowCompose(false); setComposeImages([]); }}>
                <Text style={s.cancelText}>取消</Text>
              </TouchableOpacity>
              <Text style={s.composeTitle}>发动态</Text>
              <TouchableOpacity onPress={handlePost} disabled={posting || (!composeText.trim() && composeImages.length === 0)}>
                <Text style={[s.postText, (!composeText.trim() && composeImages.length === 0 || posting) && s.postDisabled]}>
                  {uploading ? '上传中...' : posting ? '发布中...' : '发布'}
                </Text>
              </TouchableOpacity>
            </View>
            <TextInput style={s.composeInput} placeholder="分享你的想法..." placeholderTextColor="#555"
              multiline autoFocus value={composeText} onChangeText={setComposeText} maxLength={1000} />
            {composeImages.length > 0 && (
              <View style={s.previewRow}>
                {composeImages.map((uri, i) => (
                  <TouchableOpacity key={i} onPress={() => removeImage(i)} style={s.previewWrap}>
                    <Image source={{ uri }} style={s.previewImg} />
                    <View style={s.removeBadge}><Text style={s.removeX}>✕</Text></View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <View style={s.composeToolbar}>
              <TouchableOpacity onPress={pickImage} style={s.toolBtn}>
                <Text style={s.toolIcon}>🖼️</Text>
                <Text style={s.toolLabel}>图片{composeImages.length > 0 ? ` (${composeImages.length}/9)` : ''}</Text>
              </TouchableOpacity>
              <Text style={s.charCount}>{composeText.length}/1000</Text>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Comment modal */}
      <Modal visible={!!commentModal} animationType="slide" transparent>
        <KeyboardAvoidingView style={s.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={s.commentBox}>
            <View style={s.composeHeader}>
              <TouchableOpacity onPress={() => setCommentModal(null)}><Text style={s.cancelText}>取消</Text></TouchableOpacity>
              <Text style={s.composeTitle}>评论</Text>
              <TouchableOpacity onPress={handleComment} disabled={!commentText.trim()}>
                <Text style={[s.postText, !commentText.trim() && s.postDisabled]}>发送</Text>
              </TouchableOpacity>
            </View>
            <TextInput style={s.commentInput} placeholder="写评论..." placeholderTextColor="#555"
              autoFocus value={commentText} onChangeText={setCommentText} maxLength={500} />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  card: { backgroundColor: '#111', marginBottom: 8, padding: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  agentAvatar: { backgroundColor: '#ff6b35' },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  headerInfo: { flex: 1, marginLeft: 10 },
  authorName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  time: { color: '#555', fontSize: 12, marginTop: 1 },
  visIcon: { fontSize: 12, opacity: 0.5 },
  contentText: { color: '#ddd', fontSize: 15, lineHeight: 22, marginBottom: 12 },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 12 },
  singleImage: { width: '100%', height: 240, borderRadius: 8 },
  gridImage: { width: '32%', aspectRatio: 1, borderRadius: 6 },
  actions: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1a1a1a', paddingTop: 10 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', marginRight: 24 },
  actionIcon: { fontSize: 18 },
  actionCount: { color: '#888', fontSize: 13, marginLeft: 4 },
  liked: { color: '#ff6b35' },
  emptyBox: { alignItems: 'center', marginTop: 80 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  empty: { color: '#555', fontSize: 14 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: '#ff6b35', justifyContent: 'center', alignItems: 'center', shadowColor: '#ff6b35', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8 },
  fabText: { fontSize: 24 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  composeBox: { backgroundColor: '#111', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, minHeight: 320 },
  composeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  cancelText: { color: '#888', fontSize: 15 },
  composeTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  postText: { color: '#ff6b35', fontSize: 15, fontWeight: '700' },
  postDisabled: { opacity: 0.4 },
  composeInput: { color: '#fff', fontSize: 16, lineHeight: 24, minHeight: 100, textAlignVertical: 'top' },
  composeToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#1a1a1a', paddingTop: 10, marginTop: 8 },
  toolBtn: { flexDirection: 'row', alignItems: 'center' },
  toolIcon: { fontSize: 22, marginRight: 6 },
  toolLabel: { color: '#888', fontSize: 13 },
  charCount: { color: '#555', fontSize: 12 },
  previewRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  previewWrap: { position: 'relative' },
  previewImg: { width: 72, height: 72, borderRadius: 8 },
  removeBadge: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: '#ff3333', justifyContent: 'center', alignItems: 'center' },
  removeX: { color: '#fff', fontSize: 11, fontWeight: '700' },
  commentBox: { backgroundColor: '#111', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 },
  commentInput: { color: '#fff', fontSize: 15, minHeight: 60, textAlignVertical: 'top' },
});
