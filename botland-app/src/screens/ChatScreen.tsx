import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, Image, Alert, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import auth from '../services/auth';
import messageStore, { StoredMessage, MessageSegment } from '../services/messageStore';
import wsManager, { ConnectionState } from '../services/wsManager';

type Props = { route: any; navigation: any };


type Segment = MessageSegment;

function buildSegments(text: string, members: {citizen_id:string;display_name:string}[]): Segment[] {
  // Sort members by name length desc so longer names match first
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

export default function ChatScreen({ route, navigation }: Props) {
  const { friendId, friendName, groupId, groupName, chatType } = route.params || {};
  const isGroup = chatType === 'group';
  const chatId = isGroup ? groupId : friendId;
  const chatName = isGroup ? groupName : friendName;

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const flatRef = useRef<FlatList>(null);
  const [showMention, setShowMention] = useState(false);
  const [memberList, setMemberList] = useState<{citizen_id:string;display_name:string}[]>([]);
  const [mentionFilter, setMentionFilter] = useState('');
  const [groupInfo, setGroupInfo] = useState<{announcement?: string; muted_all?: boolean} | null>(null);

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
    } catch {}
  }, [isGroup, groupId]);

  useEffect(() => { void loadGroupHistory(); }, [loadGroupHistory]);

  useEffect(() => {
    if (!isGroup) return;
    (async () => {
      const token = await auth.getAccessToken();
      if (!token) return;
      try {
        const g = await api.getGroup(token, groupId);
        setMemberList((g as any).members || []);
        setGroupInfo({ announcement: (g as any).announcement, muted_all: (g as any).muted_all });
      } catch {}
    })();
  }, [isGroup, groupId]);


  useEffect(() => {
    wsManager.connect();
    const unsubState = wsManager.onStateChange((state) => {
      setConnState(state);
      if (state === 'connected' && isGroup) {
        void loadGroupHistory();
      }
    });
    const unsubMsg = wsManager.onMessage((data) => {
      if (!isGroup && data.type === 'message.received' && data.from === friendId) {
        const isImage = data.payload?.content_type === 'image';
        const msg: StoredMessage = {
          id: data.id || `r_${Date.now()}`, chatId: friendId, fromId: data.from,
          text: data.payload?.text, segments: data.payload?.segments, imageUrl: isImage ? data.payload?.url : undefined,
          contentType: isImage ? 'image' : 'text', mine: data.from !== 'system' && false, timestamp: Date.now(), status: 'delivered',
        };
        setMessages(prev => [...prev, msg]);
        messageStore.save(msg);
      }
      if (isGroup && data.type === 'group.message.received' && data.to === groupId) {
        const isImage = data.payload?.content_type === 'image';
        const msg: StoredMessage = {
          id: data.id || `r_${Date.now()}`, chatId: groupId, fromId: data.from,
          fromName: data.payload?.sender_name || data.from,
          text: data.payload?.text, segments: data.payload?.segments, imageUrl: isImage ? data.payload?.url : undefined,
          contentType: isImage ? 'image' : 'text', mine: false, timestamp: Date.now(), status: 'delivered',
        };
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
        messageStore.save(msg);
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
    if (failedMsg.contentType === 'image' && failedMsg.imageUrl) {
      payload.url = failedMsg.imageUrl;
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
    if (segments.length > 0) payload.segments = segments;
    if (mentions.length > 0) payload.mentions = mentions;
    const msg: StoredMessage = { id, chatId, fromId: myId, text: trimmed, segments: segments.length ? segments : undefined, contentType: 'text', mine: true, timestamp: Date.now(), status: 'sent' };
    wsManager.send({ type: isGroup ? 'group.message.send' : 'message.send', id, to: chatId, payload });
    setMessages(prev => [...prev, msg]);
    messageStore.save(msg);
    setInput('');
  };

  const sendImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (result.canceled || !result.assets?.[0]) return;
    setSending(true);
    const token = await auth.getAccessToken();
    const myId = wsManager.getCitizenId();
    if (!token || !myId) { setSending(false); return; }
    try {
      const upload = await api.uploadImage(token, result.assets[0].uri, 'chat');
      const id = `msg_${Date.now()}`;
      wsManager.send({ type: isGroup ? 'group.message.send' : 'message.send', id, to: chatId, payload: { content_type: 'image', url: upload.url } });
      const msg: StoredMessage = { id, chatId, fromId: myId, imageUrl: upload.url, contentType: 'image', mine: true, timestamp: Date.now(), status: 'sent' };
      setMessages(prev => [...prev, msg]);
      messageStore.save(msg);
    } catch (e: any) {
      if (typeof window !== 'undefined') window.alert('发送失败: ' + e.message);
      else Alert.alert('发送失败', e.message);
    } finally { setSending(false); }
  };

  const banner = connState === 'connected' ? null : (
    <View style={[s.banner, connState === 'reconnecting' ? s.bannerWarn : s.bannerErr]}>
      <Text style={s.bannerText}>{connState === 'connecting' ? '连接中...' : connState === 'reconnecting' ? '重连中...' : '未连接'}</Text>
    </View>
  );

  const renderMsg = ({ item }: { item: StoredMessage }) => {
    const isImage = item.contentType === 'image' && item.imageUrl;
    const isSystem = item.contentType === 'system' || item.fromId === 'system';
    if (isSystem) {
      return (
        <View style={s.systemRow}>
          <Text style={s.systemText}>{item.text}</Text>
        </View>
      );
    }
    return (
      <View style={[s.row, item.mine ? s.rowMine : s.rowTheirs]}>
        {!item.mine && isGroup && (
          <TouchableOpacity style={s.senderAvatarSmall} onPress={() => navigation.navigate('CitizenProfile', { citizenId: item.fromId, displayName: item.fromName })}><Text style={s.senderAvatarText}>{(item.fromName || '?')[0]}</Text></TouchableOpacity>
        )}
        <View style={{ maxWidth: '75%' }}>
          {!item.mine && isGroup && <Text style={s.senderName} onPress={() => navigation.navigate('CitizenProfile', { citizenId: item.fromId, displayName: item.fromName })}>{item.fromName || item.fromId?.slice(-6)}</Text>}
          <View style={[s.bubble, item.mine ? s.bubbleMine : s.bubbleTheirs]}>
            {isImage ? <Image source={{ uri: item.imageUrl }} style={s.msgImage} resizeMode="cover" /> : (
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
          </View>
          {item.mine && item.status === 'failed' && (
            <TouchableOpacity onPress={() => resendMessage(item)} style={s.resendRow}>
              <Text style={s.statusFailed}>发送失败</Text>
              <Text style={s.resendBtn}> 点击重发</Text>
            </TouchableOpacity>
          )}
          {item.mine && item.status && item.status !== 'sent' && item.status !== 'failed' && (
            <Text style={s.status}>{item.status === 'delivered' ? '已送达' : item.status === 'read' ? '已读' : ''}</Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      {banner}
      {isGroup && (groupInfo?.announcement || groupInfo?.muted_all) ? (
        <TouchableOpacity style={s.groupTopNotice} onPress={() => navigation.navigate('GroupDetail', { groupId })} activeOpacity={0.8}>
          {groupInfo?.announcement ? <Text style={s.groupTopNoticeText}>📢 {groupInfo.announcement}</Text> : null}
          {groupInfo?.muted_all ? <Text style={s.groupMuteNoticeText}>🔇 当前群已开启全员禁言</Text> : null}
          <Text style={s.groupTopNoticeHint}>点击查看群详情</Text>
        </TouchableOpacity>
      ) : null}
      <FlatList ref={flatRef} data={messages} keyExtractor={i => i.id} renderItem={renderMsg} contentContainerStyle={s.list} onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })} />
      {showMention && isGroup && (
        <View style={s.mentionOverlay}>
          {memberList
            .filter(m => m.citizen_id !== wsManager.getCitizenId() && (!mentionFilter || m.display_name.toLowerCase().includes(mentionFilter)))
            .slice(0, 6)
            .map(m => (
              <TouchableOpacity key={m.citizen_id} style={s.mentionItem} onPress={() => {
                const atIdx = input.lastIndexOf('@');
                const before = atIdx >= 0 ? input.slice(0, atIdx) : input;
                setInput(before + '@' + m.display_name + ' ');
                setShowMention(false);
              }}>
                <View style={s.mentionDot} /><Text style={s.mentionName}>{m.display_name}</Text>
              </TouchableOpacity>
            ))}
          {memberList.filter(m => m.citizen_id !== wsManager.getCitizenId()).length === 0 && (
            <Text style={s.mentionEmpty}>无可提及成员</Text>
          )}
        </View>
      )}
      <View style={s.inputRow}>
        <TouchableOpacity style={s.imgBtn} onPress={sendImage} disabled={sending}>
          {sending ? <ActivityIndicator size="small" color="#ff6b35" /> : <Text style={s.imgIcon}>🖼</Text>}
        </TouchableOpacity>
        <TextInput style={s.input} value={input} onChangeText={(t: string) => {
          setInput(t);
          if (showMention) {
            const atIdx = t.lastIndexOf('@');
            if (atIdx >= 0) { setMentionFilter(t.slice(atIdx + 1).toLowerCase()); }
            else { setShowMention(false); }
          }
        }} placeholder="输入消息..." placeholderTextColor="#555" onSubmitEditing={sendMessage} returnKeyType="send"
          onKeyPress={(e: any) => { if (isGroup && e.nativeEvent?.key === '@') { setMentionFilter(''); setShowMention(true); } }} />
        <TouchableOpacity style={s.sendBtn} onPress={sendMessage}><Text style={s.sendText}>发送</Text></TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
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
  status: { color: '#888', fontSize: 10, textAlign: 'right', marginTop: 2 },
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
});
