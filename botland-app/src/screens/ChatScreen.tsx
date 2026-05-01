import React, { useEffect, useState, useRef, useCallback, useSyncExternalStore } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, Image, Alert, ActivityIndicator, ActionSheetIOS,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Audio, Video, ResizeMode } from 'expo-av';
import api from '../services/api';
import auth from '../services/auth';
import messageStore, { StoredMessage, MessageSegment, MessageReplyPreview } from '../services/messageStore';
import wsManager, { ConnectionState } from '../services/wsManager';

type Props = { route: any; navigation: any };
type Segment = MessageSegment;

function buildSegments(text: string, members: {citizen_id:string;display_name:string}[]): Segment[] {
  const sorted = [...members].sort((a, b) => b.display_name.length - a.display_name.length);
  const segments: Segment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const atIdx = text.indexOf('@', cursor);
    if (atIdx < 0) { segments.push({ type: 'text', text: text.slice(cursor) }); break; }
    if (atIdx > cursor) segments.push({ type: 'text', text: text.slice(cursor, atIdx) });
    let matched = false;
    for (const m of sorted) {
      if (text.startsWith('@' + m.display_name, atIdx)) {
        segments.push({ type: 'mention', citizen_id: m.citizen_id, display_name: m.display_name });
        cursor = atIdx + 1 + m.display_name.length;
        matched = true;
        break;
      }
    }
    if (!matched) { segments.push({ type: 'text', text: '@' }); cursor = atIdx + 1; }
  }
  return segments;
}

function segmentsToMentions(segs: Segment[]): {citizen_id:string;display_name:string}[] {
  return segs.filter((s): s is Extract<Segment, {type:'mention'}> => s.type === 'mention');
}

function formatDuration(ms?: number) {
  const total = Math.max(1, Math.round((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function VoiceBubble({ item, mine }: { item: StoredMessage; mine: boolean }) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => () => { soundRef.current?.unloadAsync().catch(() => {}); }, []);

  const togglePlay = async () => {
    if (!item.audioUrl) return;
    try {
      if (Platform.OS === 'web') return;
      if (playing && soundRef.current) {
        await soundRef.current.pauseAsync();
        setPlaying(false);
        return;
      }
      if (!soundRef.current) {
        const { sound } = await Audio.Sound.createAsync({ uri: item.audioUrl }, { shouldPlay: true });
        soundRef.current = sound;
        setPlaying(true);
        sound.setOnPlaybackStatusUpdate((status: any) => {
          if (status.didJustFinish) setPlaying(false);
        });
      } else {
        await soundRef.current.playAsync();
        setPlaying(true);
      }
    } catch {
      Alert.alert('播放失败', '语音播放失败');
    }
  };

  if (Platform.OS === 'web') {
    return (
      <View style={[s.voiceBubble, mine ? s.voiceBubbleMine : s.voiceBubbleTheirs]}>
        <audio src={item.audioUrl} controls style={{ width: 220, height: 36 }} />
        <Text style={s.voiceDuration}>{formatDuration(item.durationMs)}</Text>
      </View>
    );
  }

  return (
    <TouchableOpacity onPress={togglePlay} style={[s.voiceBubble, mine ? s.voiceBubbleMine : s.voiceBubbleTheirs]}>
      <Text style={s.voiceIcon}>{playing ? '⏸️' : '▶️'}</Text>
      <View style={s.voiceBars}>
        <View style={s.voiceBarShort} />
        <View style={s.voiceBarMid} />
        <View style={s.voiceBarTall} />
      </View>
      <Text style={s.voiceDuration}>{formatDuration(item.durationMs)}</Text>
    </TouchableOpacity>
  );
}


function replySummary(msg: StoredMessage): string {
  if (msg.text) return msg.text;
  if (msg.contentType === 'image') return '[图片]';
  if (msg.contentType === 'video') return '[视频]';
  if (msg.contentType === 'voice') return '[语音]';
  return '[消息]';
}

function ReactionBar({ reactions }: { reactions?: { emoji: string; count: number }[] }) {
  if (!reactions || reactions.length === 0) return null;
  return (
    <View style={s.reactionBar}>
      {reactions.map((r, idx) => (
        <View key={`${r.emoji}_${idx}`} style={s.reactionChip}>
          <Text style={s.reactionText}>{r.emoji} {r.count}</Text>
        </View>
      ))}
    </View>
  );
}

function ReplyPreviewBlock({ reply, onPress }: { reply?: MessageReplyPreview; onPress?: () => void }) {
  if (!reply) return null;
  const content = (
    <View style={s.replyBlock}>
      <Text style={s.replyName}>{reply.fromName || reply.fromId || '原消息'}</Text>
      <Text style={s.replyText} numberOfLines={2}>{reply.text || (reply.contentType === 'image' ? '[图片]' : reply.contentType === 'video' ? '[视频]' : reply.contentType === 'voice' ? '[语音]' : reply.fromId ? '[消息]' : '原消息不可用')}</Text>
    </View>
  );
  if (onPress) return <TouchableOpacity onPress={onPress} activeOpacity={0.7}>{content}</TouchableOpacity>;
  return content;
}

export default function ChatScreen({ route, navigation }: Props) {
  const { friendId, friendName, groupId, groupName, chatType } = route.params || {};
  const isGroup = chatType === 'group';
  const chatId = isGroup ? groupId : friendId;
  const chatName = isGroup ? groupName : friendName;

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState<MessageReplyPreview | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);

  const [groupUnavailableHandled, setGroupUnavailableHandled] = useState(false);

  const handleGroupUnavailable = useCallback((message?: string) => {
    if (!isGroup || groupUnavailableHandled) return;
    setGroupUnavailableHandled(true);
    const text = message || '你已不在该群聊中，正在返回群列表';
    if (typeof window !== 'undefined') window.alert(text);
    else Alert.alert('群聊不可用', text);
    if (navigation.replace) navigation.replace('Groups');
    else {
      navigation.goBack?.();
      navigation.goBack?.();
    }
  }, [isGroup, groupUnavailableHandled, navigation]);

  const scrollToReply = async (replyToId?: string) => {
    if (!replyToId) return;

    const scrollToFound = (targetId: string, list: StoredMessage[]) => {
      const idx = list.findIndex(m => m.id === targetId);
      if (idx >= 0) {
        flatRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
        setHighlightId(targetId);
        setTimeout(() => setHighlightId(null), 1500);
        return true;
      }
      return false;
    };

    if (scrollToFound(replyToId, messages)) return;

    if (!isGroup) {
      // DM: try loading older history too
      if (loadingOlder || !hasMoreHistory) {
        if (Platform.OS === 'web') {
          setHighlightId('__notfound__');
          setTimeout(() => setHighlightId(null), 1500);
        } else {
          Alert.alert('提示', hasMoreHistory ? '正在加载更早消息，请稍后重试' : '已没有更早消息，原消息不可用');
        }
        return;
      }
      try {
        setLoadingOlder(true);
        const token = await auth.getAccessToken();
        if (!token) return;
        let before = messages.length > 0 ? messages[0].id : undefined;
        const myId = wsManager.getCitizenId() || '';
        for (let i = 0; i < 3; i++) {
          const history = await api.getDMHistory(token, friendId, before, 50);
          if (!history || history.length === 0) {
            setHasMoreHistory(false);
            break;
          }
          const mapped: StoredMessage[] = history.reverse().map((m: any) => {
            const p = m.payload || {};
            const ctype = p.content_type || 'text';
            return {
              id: m.id, chatId: friendId, fromId: m.sender_id, fromName: m.sender_name,
              text: p.text,
              segments: p.segments,
              imageUrl: ctype === 'image' ? p.url : undefined,
              videoUrl: ctype === 'video' ? p.url : undefined,
              audioUrl: ctype === 'voice' ? p.url : undefined,
              durationMs: p.duration_ms,
              replyTo: p.reply_to,
              replyPreview: p.reply_preview,
              contentType: ctype,
              mine: m.sender_id === myId,
              timestamp: new Date(m.created_at).getTime(), status: 'delivered' as const,
            };
          });

          let combined: StoredMessage[] = [];
          setMessages(prev => {
            const existIds = new Set(prev.map(p => p.id));
            const fresh = mapped.filter(m => !existIds.has(m.id));
            combined = [...fresh, ...prev].sort((a, b) => a.timestamp - b.timestamp);
            return combined;
          });

          if (mapped.length < 50) setHasMoreHistory(false);
          if (scrollToFound(replyToId, combined.length ? combined : messages)) return;
          before = history[history.length - 1]?.id;
        }

        if (Platform.OS === 'web') {
          setHighlightId('__notfound__');
          setTimeout(() => setHighlightId(null), 1500);
        } else {
          Alert.alert('提示', '已尝试加载更早消息，仍未找到原消息');
        }
      } catch {
        if (Platform.OS !== 'web') Alert.alert('提示', '加载历史消息失败');
      } finally {
        setLoadingOlder(false);
      }
      return;
    }

    if (loadingOlder || !hasMoreHistory) {
      if (Platform.OS === 'web') {
        setHighlightId('__notfound__');
        setTimeout(() => setHighlightId(null), 1500);
      } else {
        Alert.alert('提示', hasMoreHistory ? '正在加载更早消息，请稍后重试' : '已没有更早消息，原消息不可用');
      }
      return;
    }

    try {
      setLoadingOlder(true);
      const token = await auth.getAccessToken();
      if (!token) return;
      let before = messages.length > 0 ? messages[0].id : undefined;
      for (let i = 0; i < 3; i++) {
        const history = await api.getGroupMessages(token, groupId, before);
        if (!history || history.length === 0) {
          setHasMoreHistory(false);
          break;
        }
        const myId = wsManager.getCitizenId() || '';
        const mapped: StoredMessage[] = history.reverse().map((m: any) => ({
          id: m.id, chatId: groupId, fromId: m.sender_id, fromName: m.sender_name,
          text: m.payload?.text,
          segments: m.payload?.segments,
          imageUrl: m.payload?.content_type === 'image' ? m.payload?.url : undefined,
          videoUrl: m.payload?.content_type === 'video' ? m.payload?.url : undefined,
          audioUrl: m.payload?.content_type === 'voice' ? m.payload?.url : undefined,
          durationMs: m.payload?.duration_ms,
          replyTo: m.payload?.reply_to,
          replyPreview: m.payload?.reply_preview,
          contentType: m.payload?.content_type || 'text',
          mine: m.sender_id !== 'system' && m.sender_id === myId,
          timestamp: new Date(m.created_at).getTime(), status: 'delivered',
        }));

        let combined: StoredMessage[] = [];
        setMessages(prev => {
          const existIds = new Set(prev.map(p => p.id));
          const fresh = mapped.filter(m => !existIds.has(m.id));
          combined = [...fresh, ...prev].sort((a, b) => a.timestamp - b.timestamp);
          return combined;
        });

        if (mapped.length < 50) setHasMoreHistory(false);
        if (scrollToFound(replyToId, combined.length ? combined : messages)) return;
        before = history[history.length - 1]?.id;
      }

      if (Platform.OS === 'web') {
        setHighlightId('__notfound__');
        setTimeout(() => setHighlightId(null), 1500);
      } else {
        Alert.alert('提示', '已尝试加载更早消息，仍未找到原消息');
      }
    } catch {
      if (Platform.OS !== 'web') Alert.alert('提示', '加载历史消息失败');
    } finally {
      setLoadingOlder(false);
    }
  };
  const [recording, setRecording] = useState<any>(null);
  const [recordingMs, setRecordingMs] = useState(0);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const flatRef = useRef<FlatList>(null);
  const [showMention, setShowMention] = useState(false);
  const [memberList, setMemberList] = useState<{citizen_id:string;display_name:string}[]>([]);
  const [mentionFilter, setMentionFilter] = useState('');
  const [groupInfo, setGroupInfo] = useState<{announcement?: string; muted_all?: boolean} | null>(null);
  const typingSnap = useSyncExternalStore(
    (cb) => wsManager.subscribeTyping(chatId, cb),
    () => wsManager.getTypingSnapshot(chatId),
    () => wsManager.getTypingSnapshot(chatId)
  );
  const peerTyping = !!typingSnap.active;
  const peerTypingName = typingSnap.name || '';
  const lastTypingSentRef = useRef(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    navigation.setOptions({
      title: chatName || '聊天',
      headerRight: isGroup ? () => (
        <TouchableOpacity onPress={() => navigation.navigate('GroupDetail', { groupId })}>
          <Text style={{ color: '#ff6b35', fontSize: 14, marginRight: 8 }}>群详情</Text>
        </TouchableOpacity>
      ) : undefined,
    });
  }, [navigation, chatName, isGroup, groupId]);

  const loadLocal = useCallback(async () => {
    const local = await messageStore.getMessages(chatId, 200);
    if (local.length > 0) setMessages(local);
  }, [chatId]);

  useEffect(() => { loadLocal(); }, [loadLocal]);

  const loadGroupHistory = useCallback(async () => {
    if (!isGroup) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const history = await api.getGroupMessages(token, groupId);
      if (history && history.length > 0) {
        const myId = wsManager.getCitizenId() || '';
        const mapped: StoredMessage[] = history.reverse().map((m: any) => ({
          id: m.id, chatId: groupId, fromId: m.sender_id, fromName: m.sender_name,
          text: m.payload?.text,
          segments: m.payload?.segments,
          imageUrl: m.payload?.content_type === 'image' ? m.payload?.url : undefined,
          videoUrl: m.payload?.content_type === 'video' ? m.payload?.url : undefined,
          audioUrl: m.payload?.content_type === 'voice' ? m.payload?.url : undefined,
          durationMs: m.payload?.duration_ms,
          replyTo: m.payload?.reply_to,
          replyPreview: m.payload?.reply_preview,
          contentType: m.payload?.content_type || 'text',
          mine: m.sender_id !== 'system' && m.sender_id === myId,
          timestamp: new Date(m.created_at).getTime(), status: 'delivered',
        }));
        setMessages(prev => {
          const existIds = new Set(prev.map(p => p.id));
          const fresh = mapped.filter(m => !existIds.has(m.id));
          return [...fresh, ...prev].sort((a, b) => a.timestamp - b.timestamp);
        });
      }
    } catch (e: any) {
      const msg = e?.message || '';
      if (msg.includes('not a member') || msg.includes('group not found')) handleGroupUnavailable('该群聊已不可访问，正在返回群列表');
    }
  }, [isGroup, groupId, handleGroupUnavailable]);

  useEffect(() => { void loadGroupHistory(); }, [loadGroupHistory]);

  const loadDMHistory = useCallback(async () => {
    if (isGroup) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    try {
      const history = await api.getDMHistory(token, friendId, undefined, 50);
      if (history && history.length > 0) {
        const myId = wsManager.getCitizenId() || '';
        const mapped: StoredMessage[] = history.reverse().map((m: any) => {
          const p = m.payload || {};
          const ctype = p.content_type || 'text';
          return {
            id: m.id, chatId: friendId, fromId: m.sender_id, fromName: m.sender_name,
            text: p.text,
            segments: p.segments,
            imageUrl: ctype === 'image' ? p.url : undefined,
            videoUrl: ctype === 'video' ? p.url : undefined,
            audioUrl: ctype === 'voice' ? p.url : undefined,
            durationMs: p.duration_ms,
            replyTo: p.reply_to,
            replyPreview: p.reply_preview,
            reactions: p.reactions,
            contentType: ctype,
            mine: m.sender_id === myId,
            timestamp: new Date(m.created_at).getTime(), status: 'delivered',
          };
        });
        setMessages(prev => {
          const existIds = new Set(prev.map(p => p.id));
          const fresh = mapped.filter(m => !existIds.has(m.id));
          return [...fresh, ...prev].sort((a, b) => a.timestamp - b.timestamp);
        });
      }
    } catch {}
  }, [isGroup, friendId]);

  useEffect(() => { if (!isGroup) void loadDMHistory(); }, [isGroup, loadDMHistory]);

  useEffect(() => {
    if (!isGroup) return;
    (async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try {
        const g = await api.getGroup(token, groupId);
        setMemberList((g as any).members || []);
        setGroupInfo({ announcement: (g as any).announcement, muted_all: (g as any).muted_all });
      } catch (e: any) {
        const msg = e?.message || '';
        if (msg.includes('not a member') || msg.includes('group not found')) handleGroupUnavailable('你已不在该群聊中，正在返回群列表');
      }
    })();
  }, [isGroup, groupId, handleGroupUnavailable]);

  useEffect(() => {
    wsManager.connect();
    const unsubState = wsManager.onStateChange((state) => {
      setConnState(state);
      if (state === 'connected') {
        if (isGroup) void loadGroupHistory();
        else void loadDMHistory();
      }
    });
    const unsubMsg = wsManager.onMessage((data) => {
      if (!isGroup && data.type === 'message.received' && data.from === friendId) {
        const ctype = data.payload?.content_type || 'text';
        const msg: StoredMessage = {
          id: data.id || `r_${Date.now()}`, chatId: friendId, fromId: data.from,
          text: data.payload?.text, segments: data.payload?.segments,
          imageUrl: ctype === 'image' ? data.payload?.url : undefined,
          videoUrl: ctype === 'video' ? data.payload?.url : undefined,
          audioUrl: ctype === 'voice' ? data.payload?.url : undefined,
          durationMs: data.payload?.duration_ms,
          replyTo: data.payload?.reply_to,
          replyPreview: data.payload?.reply_preview,
          contentType: ctype, mine: data.from !== 'system' && false, timestamp: Date.now(), status: 'delivered',
        };
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
        messageStore.save(msg);
        if (data.id) wsManager.send({ type: 'message.ack', id: data.id, to: data.from });
      }
      if (isGroup && data.type === 'group.message.received' && data.to === groupId) {
        const ctype = data.payload?.content_type || 'text';
        const msg: StoredMessage = {
          id: data.id || `r_${Date.now()}`, chatId: groupId, fromId: data.from,
          fromName: data.payload?.sender_name || data.from,
          text: data.payload?.text, segments: data.payload?.segments,
          imageUrl: ctype === 'image' ? data.payload?.url : undefined,
          videoUrl: ctype === 'video' ? data.payload?.url : undefined,
          audioUrl: ctype === 'voice' ? data.payload?.url : undefined,
          durationMs: data.payload?.duration_ms,
          replyTo: data.payload?.reply_to,
          replyPreview: data.payload?.reply_preview,
          contentType: ctype, mine: false, timestamp: Date.now(), status: 'delivered',
        };
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
        messageStore.save(msg);
      }

      if (data.type === 'message.reaction') {
        const { message_id: messageId, emoji } = data.payload || {};
        if (messageId && emoji) {
          setMessages(prev => prev.map(m => {
            if (m.id !== messageId) return m;
            const existing = Array.isArray(m.reactions) ? [...m.reactions] : [];
            const idx = existing.findIndex((r: any) => r.emoji === emoji);
            if (idx >= 0) existing[idx] = { ...existing[idx], count: (existing[idx].count || 0) + 1 };
            else existing.push({ emoji, count: 1 });
            const next = { ...m, reactions: existing };
            void messageStore.updateReactions(m.id, existing as any);
            return next;
          }));
        }
      }

      if (data.type === 'error') {
        const code = data.payload?.code;
        const msg = data.payload?.message;
        const refId = data.payload?.ref_id;
        setMessages(prev => {
          const copy = [...prev];
          if (refId) {
            const idx = copy.findIndex(m => m.id === refId);
            if (idx >= 0) {
              copy[idx] = { ...copy[idx], status: 'failed' };
              void messageStore.updateStatus(copy[idx].id, 'failed');
            }
          } else {
            for (let i = copy.length - 1; i >= 0; i--) {
              if (copy[i].mine && copy[i].status === 'sent') {
                copy[i] = { ...copy[i], status: 'failed' };
                void messageStore.updateStatus(copy[i].id, 'failed');
                break;
              }
            }
          }
          return copy;
        });
        if (code === 'group_muted') {
          const text = '当前群已开启全员禁言，只有群主和管理员可以发言';
          if (typeof window !== 'undefined') window.alert(text);
          else Alert.alert('无法发送', text);
          return;
        }
        if (msg) {
          if (typeof window !== 'undefined') window.alert(msg);
          else Alert.alert('发送失败', msg);
          return;
        }
      }
      if (data.type === 'message.status') {
        const { status, message_id: msgId } = data.payload || {};
        if (msgId && (status === 'delivered' || status === 'read')) {
          setMessages(prev => prev.map(m => m.id === msgId ? { ...m, status } : m));
          messageStore.updateStatus(msgId, status);
        }
      }
    });
    return () => { unsubState(); unsubMsg(); };
  }, [friendId, groupId, isGroup, loadGroupHistory]);

  const resendMessage = async (failedMsg: StoredMessage) => {
    const myId = wsManager.getCitizenId();
    if (!myId) return;
    const newId = `msg_${Date.now()}`;
    const payload: any = { content_type: failedMsg.contentType };
    if (failedMsg.replyTo) payload.reply_to = failedMsg.replyTo;
    if (failedMsg.replyPreview) payload.reply_preview = failedMsg.replyPreview;
    if (failedMsg.contentType === 'image' && failedMsg.imageUrl) payload.url = failedMsg.imageUrl;
    else if (failedMsg.contentType === 'video' && failedMsg.videoUrl) payload.url = failedMsg.videoUrl;
    else if (failedMsg.contentType === 'voice' && failedMsg.audioUrl) {
      payload.url = failedMsg.audioUrl;
      if (failedMsg.durationMs) payload.duration_ms = failedMsg.durationMs;
    } else {
      payload.text = failedMsg.text;
      if (failedMsg.segments) payload.segments = failedMsg.segments;
      const mentions = (failedMsg.segments || []).filter((s: any) => s.type === 'mention');
      if (mentions.length > 0) payload.mentions = mentions;
    }
    wsManager.send({ type: isGroup ? 'group.message.send' : 'message.send', id: newId, to: chatId, payload });
    setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...m, id: newId, status: 'sent' as const, timestamp: Date.now() } : m));
    void messageStore.updateStatus(failedMsg.id, 'delivered');
  };

  const sendMessage = async () => {
    if (!input.trim()) return;
    const myId = wsManager.getCitizenId();
    if (!myId) return;
    const id = `msg_${Date.now()}`;
    const trimmed = input.trim();
    const segments = isGroup ? buildSegments(trimmed, memberList) : [];
    const mentions = segmentsToMentions(segments);
    const payload: any = { content_type: 'text', text: trimmed };
    if (replyingTo?.id) payload.reply_to = replyingTo.id;
    if (replyingTo) payload.reply_preview = replyingTo;
    if (segments.length > 0) payload.segments = segments;
    if (mentions.length > 0) payload.mentions = mentions;
    const msg: StoredMessage = { id, chatId, fromId: myId, text: trimmed, segments: segments.length ? segments : undefined, replyTo: replyingTo?.id, replyPreview: replyingTo || undefined, contentType: 'text', mine: true, timestamp: Date.now(), status: 'sent' };
    wsManager.send({ type: isGroup ? 'group.message.send' : 'message.send', id, to: chatId, payload });
    setMessages(prev => [...prev, msg]);
    messageStore.save(msg);
    setInput('');
    setReplyingTo(null);
  };

  const sendMedia = async (mediaType: 'images' | 'videos') => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: mediaType === 'videos' ? ['videos'] : ['images'],
      quality: 0.8,
      videoMaxDuration: 120,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setSending(true);
    const token = await auth.getAccessToken();
    const myId = wsManager.getCitizenId();
    if (!token || !myId) { setSending(false); return; }
    try {
      const asset = result.assets[0];
      const isVid = mediaType === 'videos' || asset.type === 'video';
      const upload = await api.uploadMedia(token, asset.uri, isVid ? 'video' : 'chat');
      const id = `msg_${Date.now()}`;
      const cType = isVid ? 'video' : 'image';
      const payload: any = { content_type: cType, url: upload.url };
      if (replyingTo?.id) payload.reply_to = replyingTo.id;
      if (replyingTo) payload.reply_preview = replyingTo;
      wsManager.send({ type: isGroup ? 'group.message.send' : 'message.send', id, to: chatId, payload });
      const msg: StoredMessage = {
        id, chatId, fromId: myId,
        imageUrl: isVid ? undefined : upload.url,
        videoUrl: isVid ? upload.url : undefined,
        replyTo: replyingTo?.id,
        replyPreview: replyingTo || undefined,
        contentType: cType, mine: true, timestamp: Date.now(), status: 'sent',
      };
      setMessages(prev => [...prev, msg]);
      messageStore.save(msg);
      setReplyingTo(null);
      setReplyingTo(null);
    } catch (e: any) {
      if (typeof window !== 'undefined') window.alert('发送失败: ' + e.message);
      else Alert.alert('发送失败', e.message);
    } finally { setSending(false); }
  };

  const startRecording = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('暂不支持', 'Web 端暂不支持录音，请使用手机端');
      return;
    }
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('需要权限', '请允许麦克风权限后再录音');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      setRecording(rec);
      setRecordingMs(0);
      recordTimerRef.current = setInterval(() => setRecordingMs(v => v + 200), 200);
    } catch (e: any) {
      Alert.alert('录音失败', e?.message || '无法开始录音');
    }
  };

  const stopRecordingAndSend = async () => {
    if (!recording) return;
    try {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      const status: any = await recording.getStatusAsync();
      setRecording(null);
      const durationMs = status?.durationMillis || recordingMs;
      setRecordingMs(0);
      if (!uri || durationMs < 500) return;
      setSending(true);
      const token = await auth.getAccessToken();
      const myId = wsManager.getCitizenId();
      if (!token || !myId) return;
      const upload = await api.uploadMedia(token, uri, 'audio');
      const id = `msg_${Date.now()}`;
      const payload: any = { content_type: 'voice', url: upload.url, duration_ms: durationMs };
      if (replyingTo?.id) payload.reply_to = replyingTo.id;
      if (replyingTo) payload.reply_preview = replyingTo;
      wsManager.send({
        type: isGroup ? 'group.message.send' : 'message.send',
        id,
        to: chatId,
        payload,
      });
      const msg: StoredMessage = {
        id, chatId, fromId: myId,
        audioUrl: upload.url,
        durationMs,
        replyTo: replyingTo?.id,
        replyPreview: replyingTo || undefined,
        contentType: 'voice',
        mine: true, timestamp: Date.now(), status: 'sent',
      };
      setMessages(prev => [...prev, msg]);
      messageStore.save(msg);
      setReplyingTo(null);
    } catch (e: any) {
      Alert.alert('发送失败', e?.message || '语音发送失败');
    } finally {
      setSending(false);
      try { await Audio.setAudioModeAsync({ allowsRecordingIOS: false }); } catch {}
    }
  };

  const cancelRecording = async () => {
    if (!recording) return;
    try {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      await recording.stopAndUnloadAsync();
    } catch {}
    setRecording(null);
    setRecordingMs(0);
    try { await Audio.setAudioModeAsync({ allowsRecordingIOS: false }); } catch {}
  };

  const sendTypingIndicator = () => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2000) return;
    lastTypingSentRef.current = now;
    wsManager.send({ type: isGroup ? 'group.typing.start' : 'typing.start', to: chatId });
  };

  const banner = connState === 'connected' ? null : (
    <View style={[s.banner, connState === 'reconnecting' ? s.bannerWarn : s.bannerErr]}>
      <Text style={s.bannerText}>{connState === 'connecting' ? '连接中...' : connState === 'reconnecting' ? '重连中...' : '未连接'}</Text>
    </View>
  );


  const sendReaction = (item: StoredMessage, emoji: string) => {
    if (!item?.id) return;
    const target = chatId;
    wsManager.send({
      type: 'message.reaction',
      to: target,
      payload: { message_id: item.id, emoji },
    });
    setMessages(prev => prev.map(m => {
      if (m.id !== item.id) return m;
      const existing = Array.isArray(m.reactions) ? [...m.reactions] : [];
      const idx = existing.findIndex((r: any) => r.emoji === emoji);
      if (idx >= 0) existing[idx] = { ...existing[idx], count: (existing[idx].count || 0) + 1 };
      else existing.push({ emoji, count: 1 });
      const next = { ...m, reactions: existing };
      void messageStore.updateReactions(m.id, existing as any);
      return next;
    }));
  };

  const beginReply = (item: StoredMessage) => {
    setReplyingTo({
      id: item.id,
      fromId: item.fromId,
      fromName: item.mine ? '你' : (item.fromName || chatName || item.fromId),
      text: replySummary(item),
      contentType: item.contentType,
    });
  };

  const onMessageLongPress = (item: StoredMessage) => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({
        options: ['取消', '回复', '❤️', '👍', '😂'],
        cancelButtonIndex: 0,
      }, (buttonIndex) => {
        if (buttonIndex === 1) beginReply(item);
        if (buttonIndex === 2) sendReaction(item, '❤️');
        if (buttonIndex === 3) sendReaction(item, '👍');
        if (buttonIndex === 4) sendReaction(item, '😂');
      });
      return;
    }
    Alert.alert('消息操作', '选择要执行的操作', [
      { text: '取消', style: 'cancel' },
      { text: '回复', onPress: () => beginReply(item) },
      { text: '❤️', onPress: () => sendReaction(item, '❤️') },
      { text: '👍', onPress: () => sendReaction(item, '👍') },
      { text: '😂', onPress: () => sendReaction(item, '😂') },
    ]);
  };

  const renderMsg = ({ item }: { item: StoredMessage }) => {
    const isImage = item.contentType === 'image' && item.imageUrl;
    const isVideo = item.contentType === 'video' && item.videoUrl;
    const isVoice = item.contentType === 'voice' && item.audioUrl;
    const isSystem = item.contentType === 'system' || item.fromId === 'system';
    if (isSystem) {
      return <View style={s.systemRow}><Text style={s.systemText}>{item.text}</Text></View>;
    }
    return (
      <View style={[s.row, item.mine ? s.rowMine : s.rowTheirs, highlightId === item.id && s.highlightRow]}>
        {!item.mine && isGroup && (
          <TouchableOpacity style={s.senderAvatarSmall} onPress={() => navigation.navigate('CitizenProfile', { citizenId: item.fromId, displayName: item.fromName })}><Text style={s.senderAvatarText}>{(item.fromName || '?')[0]}</Text></TouchableOpacity>
        )}
        <View style={{ maxWidth: '75%' }}>
          {!item.mine && isGroup && <Text style={s.senderName} onPress={() => navigation.navigate('CitizenProfile', { citizenId: item.fromId, displayName: item.fromName })}>{item.fromName || item.fromId?.slice(-6)}</Text>}
          <TouchableOpacity activeOpacity={0.9} onLongPress={() => onMessageLongPress(item)} style={[s.bubble, item.mine ? s.bubbleMine : s.bubbleTheirs]}>
            <ReplyPreviewBlock reply={item.replyPreview} onPress={item.replyTo ? () => scrollToReply(item.replyTo) : undefined} />
            {isVideo ? (
              Platform.OS === 'web' ? (
                <video src={item.videoUrl} controls style={{ width: 240, height: 180, borderRadius: 8, backgroundColor: '#000' }} playsInline />
              ) : (
                <Video source={{ uri: item.videoUrl! }} style={s.msgVideo} useNativeControls resizeMode={ResizeMode.CONTAIN} isLooping={false} />
              )
            ) : isImage ? (
              <Image source={{ uri: item.imageUrl }} style={s.msgImage} resizeMode="cover" />
            ) : isVoice ? (
              <VoiceBubble item={item} mine={item.mine} />
            ) : (
              <Text style={s.text}>{(() => {
                const segs = item.segments || (isGroup ? buildSegments(item.text || '', memberList) : []);
                if (!segs || segs.length === 0) return item.text;
                return segs.map((seg, i) =>
                  seg.type === 'mention'
                    ? <Text key={i} style={s.mentionHighlight} onPress={() => navigation.navigate('CitizenProfile', { citizenId: seg.citizen_id, displayName: seg.display_name })}>@{seg.display_name}</Text>
                    : <Text key={i}>{seg.text}</Text>
                );
              })()}</Text>
            )}
            <ReactionBar reactions={item.reactions as any} />
          </TouchableOpacity>
          {item.mine && item.status === 'failed' && (
            <TouchableOpacity onPress={() => resendMessage(item)} style={s.resendRow}><Text style={s.statusFailed}>发送失败</Text><Text style={s.resendBtn}> 点击重发</Text></TouchableOpacity>
          )}
          {item.mine && item.status && item.status !== 'failed' && (
            <Text style={[s.status, item.status === 'read' ? s.statusRead : null]}>
              {item.status === 'sent' ? '✓' : item.status === 'delivered' ? '✓✓' : item.status === 'read' ? '✓✓ 已读' : ''}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      {Platform.OS === 'web' && (
        <View style={s.webHeader}>
          <Text style={s.webHeaderTitle}>{chatName || '聊天'}</Text>
          {isGroup && (<TouchableOpacity onPress={() => navigation.navigate('GroupDetail', { groupId })}><Text style={s.webHeaderAction}>群详情</Text></TouchableOpacity>)}
        </View>
      )}
      {banner}
      {isGroup && (groupInfo?.announcement || groupInfo?.muted_all) ? (
        <TouchableOpacity style={s.groupTopNotice} onPress={() => navigation.navigate('GroupDetail', { groupId })} activeOpacity={0.8}>
          {groupInfo?.announcement ? <Text style={s.groupTopNoticeText}>📢 {groupInfo.announcement}</Text> : null}
          {groupInfo?.muted_all ? <Text style={s.groupMuteNoticeText}>🔇 当前群已开启全员禁言</Text> : null}
          <Text style={s.groupTopNoticeHint}>点击查看群详情</Text>
        </TouchableOpacity>
      ) : null}
      <FlatList ref={flatRef} data={messages} keyExtractor={i => i.id} renderItem={renderMsg} contentContainerStyle={s.list} onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })} onScrollToIndexFailed={(info) => { setTimeout(() => { flatRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.3 }); }, 200); }} />
      {showMention && isGroup && (
        <View style={s.mentionOverlay}>
          {memberList.filter(m => m.citizen_id !== wsManager.getCitizenId() && (!mentionFilter || m.display_name.toLowerCase().includes(mentionFilter))).slice(0, 6).map(m => (
            <TouchableOpacity key={m.citizen_id} style={s.mentionItem} onPress={() => {
              const atIdx = input.lastIndexOf('@');
              const before = atIdx >= 0 ? input.slice(0, atIdx) : input;
              setInput(before + '@' + m.display_name + ' ');
              setShowMention(false);
            }}>
              <View style={s.mentionDot} /><Text style={s.mentionName}>{m.display_name}</Text>
            </TouchableOpacity>
          ))}
          {memberList.filter(m => m.citizen_id !== wsManager.getCitizenId()).length === 0 && (<Text style={s.mentionEmpty}>无可提及成员</Text>)}
        </View>
      )}
      {replyingTo && <View style={s.replyComposer}><View style={{flex:1}}><Text style={s.replyComposerTitle}>回复 {replyingTo.fromName || replyingTo.fromId || '消息'}</Text><Text style={s.replyComposerText} numberOfLines={1}>{replyingTo.text || '[消息]'}</Text></View><TouchableOpacity onPress={() => setReplyingTo(null)}><Text style={s.replyComposerClose}>×</Text></TouchableOpacity></View>}
      {peerTyping && <View testID="typing-indicator" accessibilityLabel="typing-indicator" style={s.typingBar}><Text style={s.typingText}>{isGroup ? `${peerTypingName} ` : ''}正在输入...</Text></View>}
      {recording && <View style={s.recordingBar}><Text style={s.recordingText}>🎙️ 录音中 {formatDuration(recordingMs)} · 松开发送 / 点×取消</Text><TouchableOpacity onPress={cancelRecording}><Text style={s.recordingCancel}>取消</Text></TouchableOpacity></View>}
      <View style={s.inputRow}>
        <TouchableOpacity style={s.imgBtn} onPress={() => sendMedia('images')} disabled={sending || !!recording}>
          {sending ? <ActivityIndicator size="small" color="#ff6b35" /> : <Text style={s.imgIcon}>🖼</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={s.imgBtn} onPressIn={startRecording} onPressOut={stopRecordingAndSend} disabled={sending}>
          <Text style={s.imgIcon}>{recording ? '🔴' : '🎤'}</Text>
        </TouchableOpacity>
        <TextInput style={s.input} value={input} editable={!recording} onChangeText={(t: string) => {
          setInput(t);
          if (t.trim()) sendTypingIndicator();
          if (showMention) {
            const atIdx = t.lastIndexOf('@');
            if (atIdx >= 0) setMentionFilter(t.slice(atIdx + 1).toLowerCase());
            else setShowMention(false);
          }
        }} placeholder={recording ? '录音中…' : '输入消息...'} placeholderTextColor="#555" onSubmitEditing={sendMessage} returnKeyType="send" onKeyPress={(e: any) => { if (isGroup && e.nativeEvent?.key === '@') { setMentionFilter(''); setShowMention(true); } }} />
        <TouchableOpacity style={s.sendBtn} onPress={sendMessage} disabled={!!recording}><Text style={s.sendText}>发送</Text></TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  webHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', backgroundColor: '#0f0f0f' },
  webHeaderTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  webHeaderAction: { color: '#ff6b35', fontSize: 14 },
  banner: { padding: 6, alignItems: 'center' },
  bannerWarn: { backgroundColor: '#b45309' },
  bannerErr: { backgroundColor: '#991b1b' },
  bannerText: { color: '#fff', fontSize: 12 },
  groupTopNotice: { backgroundColor: '#141414', borderBottomWidth: 1, borderBottomColor: '#222', paddingHorizontal: 12, paddingVertical: 8 },
  groupTopNoticeText: { color: '#ffd166', fontSize: 12 },
  groupMuteNoticeText: { color: '#9ec5ff', fontSize: 12, marginTop: 4 },
  groupTopNoticeHint: { color: '#666', fontSize: 11, marginTop: 4 },
  list: { padding: 12, paddingBottom: 8 },
  row: { marginBottom: 10, flexDirection: 'row' },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  senderAvatarSmall: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center', marginRight: 6, marginTop: 14 },
  senderAvatarText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  senderName: { color: '#888', fontSize: 11, marginBottom: 2, marginLeft: 2 },
  bubble: { padding: 10, borderRadius: 16, maxWidth: '100%' },
  bubbleMine: { backgroundColor: '#ff6b35', borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: '#1a1a1a', borderBottomLeftRadius: 4 },
  text: { color: '#fff', fontSize: 15 },
  msgImage: { width: 200, height: 200, borderRadius: 12 },
  msgVideo: { width: 240, height: 180, borderRadius: 12, backgroundColor: '#000' },
  voiceBubble: { flexDirection: 'row', alignItems: 'center', minWidth: 140, gap: 8 },
  voiceBubbleMine: {},
  voiceBubbleTheirs: {},
  voiceIcon: { fontSize: 18 },
  voiceBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, flex: 1 },
  voiceBarShort: { width: 4, height: 10, borderRadius: 2, backgroundColor: '#fff' },
  voiceBarMid: { width: 4, height: 16, borderRadius: 2, backgroundColor: '#fff' },
  voiceBarTall: { width: 4, height: 22, borderRadius: 2, backgroundColor: '#fff' },
  voiceDuration: { color: '#fff', fontSize: 12, opacity: 0.9 },
  status: { color: '#888', fontSize: 10, textAlign: 'right', marginTop: 2 },
  statusRead: { color: '#34c759' },
  statusFailed: { color: '#ff6b6b', fontSize: 10 },
  resendRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 2 },
  resendBtn: { color: '#ff6b35', fontSize: 10, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'center', padding: 8, borderTopWidth: 1, borderTopColor: '#222', backgroundColor: '#111' },
  imgBtn: { padding: 8 },
  imgIcon: { fontSize: 22 },
  input: { flex: 1, backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 15, marginHorizontal: 8 },
  sendBtn: { backgroundColor: '#ff6b35', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  sendText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  mentionOverlay: { backgroundColor: '#1a1a1a', borderTopWidth: 1, borderTopColor: '#333', maxHeight: 200, paddingVertical: 4 },
  mentionItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 16 },
  mentionDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ff6b35', marginRight: 10 },
  mentionName: { color: '#fff', fontSize: 15 },
  mentionEmpty: { color: '#555', textAlign: 'center', paddingVertical: 12, fontSize: 13 },
  mentionHighlight: { color: '#ff6b35', fontWeight: '600' },
  systemRow: { alignItems: 'center', marginVertical: 8 },
  systemText: { color: '#888', fontSize: 12, backgroundColor: '#141414', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, overflow: 'hidden' },
  typingBar: { paddingHorizontal: 16, paddingVertical: 4, backgroundColor: '#111' },
  typingText: { color: '#888', fontSize: 12, fontStyle: 'italic' },
  recordingBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#2a1510', borderTopWidth: 1, borderTopColor: '#5a2b1f' },
  recordingText: { color: '#ffb199', fontSize: 13 },
  recordingCancel: { color: '#ff6b35', fontWeight: '700' },
  highlightRow: { backgroundColor: 'rgba(255,107,53,0.15)', borderRadius: 12 },
  replyBlock: { borderLeftWidth: 3, borderLeftColor: 'rgba(255,255,255,0.45)', backgroundColor: 'rgba(0,0,0,0.14)', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, marginBottom: 8 },
  replyName: { color: '#ffe0d1', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  replyText: { color: '#fff', opacity: 0.85, fontSize: 12 },
  replyComposer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#171717', borderTopWidth: 1, borderTopColor: '#2a2a2a' },
  replyComposerTitle: { color: '#ff6b35', fontSize: 12, fontWeight: '700' },
  replyComposerText: { color: '#bbb', fontSize: 12, marginTop: 2 },
  replyComposerClose: { color: '#888', fontSize: 26, marginLeft: 10, lineHeight: 26 },
  reactionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  reactionChip: { backgroundColor: 'rgba(0,0,0,0.18)', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  reactionText: { color: '#fff', fontSize: 12 },
});
