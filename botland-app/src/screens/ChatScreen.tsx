import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, Image, Alert, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import auth from '../services/auth';
import messageStore, { StoredMessage } from '../services/messageStore';
import wsManager, { ConnectionState } from '../services/wsManager';

type Props = { route: any; navigation: any };

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
          text: data.payload?.text, imageUrl: isImage ? data.payload?.url : undefined,
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
          text: data.payload?.text, imageUrl: isImage ? data.payload?.url : undefined,
          contentType: isImage ? 'image' : 'text', mine: false, timestamp: Date.now(), status: 'delivered',
        };
        setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
        messageStore.save(msg);
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

  const sendMessage = async () => {
    if (!input.trim()) return;
    const myId = wsManager.getCitizenId();
    if (!myId) return;
    const id = `msg_${Date.now()}`;
    const msg: StoredMessage = { id, chatId, fromId: myId, text: input, contentType: 'text', mine: true, timestamp: Date.now(), status: 'sent' };
    wsManager.send({ type: isGroup ? 'group.message.send' : 'message.send', id, to: chatId, payload: { content_type: 'text', text: input } });
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
          <View style={s.senderAvatarSmall}><Text style={s.senderAvatarText}>{(item.fromName || '?')[0]}</Text></View>
        )}
        <View style={{ maxWidth: '75%' }}>
          {!item.mine && isGroup && <Text style={s.senderName}>{item.fromName || item.fromId?.slice(-6)}</Text>}
          <View style={[s.bubble, item.mine ? s.bubbleMine : s.bubbleTheirs]}>
            {isImage ? <Image source={{ uri: item.imageUrl }} style={s.msgImage} resizeMode="cover" /> : <Text style={s.text}>{item.text}</Text>}
          </View>
          {item.mine && item.status && item.status !== 'sent' && (
            <Text style={s.status}>{item.status === 'delivered' ? '已送达' : item.status === 'read' ? '已读' : ''}</Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      {banner}
      <FlatList ref={flatRef} data={messages} keyExtractor={i => i.id} renderItem={renderMsg} contentContainerStyle={s.list} onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })} />
      <View style={s.inputRow}>
        <TouchableOpacity style={s.imgBtn} onPress={sendImage} disabled={sending}>
          {sending ? <ActivityIndicator size="small" color="#ff6b35" /> : <Text style={s.imgIcon}>🖼</Text>}
        </TouchableOpacity>
        <TextInput style={s.input} value={input} onChangeText={setInput} placeholder="输入消息..." placeholderTextColor="#555" onSubmitEditing={sendMessage} returnKeyType="send" />
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
  inputRow: { flexDirection: 'row', alignItems: 'center', padding: 8, borderTopWidth: 1, borderTopColor: '#222', backgroundColor: '#111' },
  imgBtn: { padding: 8 },
  imgIcon: { fontSize: 22 },
  input: { flex: 1, backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 15, marginHorizontal: 8 },
  sendBtn: { backgroundColor: '#ff6b35', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  sendText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  systemRow: { alignItems: 'center', marginVertical: 8 },
  systemText: { color: '#888', fontSize: 12, backgroundColor: '#141414', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, overflow: 'hidden' },
});
