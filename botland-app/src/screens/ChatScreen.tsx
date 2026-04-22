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

type Props = { route: any };

export default function ChatScreen({ route }: Props) {
  const { friendId, friendName } = route.params;
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const flatRef = useRef<FlatList>(null);

  // Load local messages on mount
  const loadLocal = useCallback(async () => {
    const local = await messageStore.getMessages(friendId, 200);
    if (local.length > 0) {
      setMessages(local);
    }
  }, [friendId]);

  useEffect(() => { loadLocal(); }, [loadLocal]);

  // Connect wsManager and subscribe to messages
  useEffect(() => {
    // Ensure connected
    wsManager.connect();

    // Subscribe to connection state
    const unsubState = wsManager.onStateChange(setConnState);

    // Subscribe to inbound messages
    const unsubMsg = wsManager.onMessage((data) => {
      if (data.type === 'message.received' && data.from === friendId) {
        const isImage = data.payload?.content_type === 'image';
        const msg: StoredMessage = {
          id: data.id || `r_${Date.now()}`,
          chatId: friendId,
          fromId: data.from,
          text: data.payload?.text,
          imageUrl: isImage ? data.payload?.url : undefined,
          contentType: isImage ? 'image' : 'text',
          mine: false,
          timestamp: Date.now(),
          status: 'delivered',
        };
        setMessages(prev => [...prev, msg]);
        messageStore.save(msg);
      }

      if (data.type === 'message.status') {
        const status = data.payload?.status;
        const msgId = data.payload?.message_id;
        if (msgId && (status === 'delivered' || status === 'read')) {
          setMessages(prev => prev.map(m =>
            m.id === msgId ? { ...m, status } : m
          ));
          messageStore.updateStatus(msgId, status);
        }
      }
    });

    return () => {
      unsubState();
      unsubMsg();
      // Don't disconnect wsManager here — it's shared globally
    };
  }, [friendId]);

  const sendMessage = async () => {
    if (!input.trim()) return;
    const myId = wsManager.getCitizenId();
    if (!myId) return;

    const id = `msg_${Date.now()}`;
    const msg: StoredMessage = {
      id,
      chatId: friendId,
      fromId: myId,
      text: input,
      contentType: 'text',
      mine: true,
      timestamp: Date.now(),
      status: 'sent',
    };

    // Use wsManager.send — it queues if disconnected
    wsManager.send({
      type: 'message.send', id, to: friendId,
      payload: { content_type: 'text', text: input },
    });

    setMessages(prev => [...prev, msg]);
    messageStore.save(msg);
    setInput('');
  };

  const sendImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;

    setSending(true);
    const token = await auth.getAccessToken();
    const myId = wsManager.getCitizenId();
    if (!token || !myId) return;
    try {
      const upload = await api.uploadImage(token, result.assets[0].uri, 'chat');
      const id = `msg_${Date.now()}`;

      wsManager.send({
        type: 'message.send', id, to: friendId,
        payload: { content_type: 'image', url: upload.url },
      });

      const msg: StoredMessage = {
        id,
        chatId: friendId,
        fromId: myId,
        imageUrl: upload.url,
        contentType: 'image',
        mine: true,
        timestamp: Date.now(),
        status: 'sent',
      };
      setMessages(prev => [...prev, msg]);
      messageStore.save(msg);
    } catch (e: any) {
      Alert.alert('发送失败', e.message);
    } finally {
      setSending(false);
    }
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const renderItem = ({ item }: { item: StoredMessage }) => (
    <View style={[s.bubble, item.mine ? s.mine : s.theirs]}>
      {item.imageUrl && <Image source={{ uri: item.imageUrl }} style={s.chatImage} resizeMode="cover" />}
      {item.text && <Text style={s.msgText}>{item.text}</Text>}
      <View style={s.metaRow}>
        <Text style={s.time}>{formatTime(item.timestamp)}</Text>
        {item.mine && (
          <Text style={s.status}>
            {item.status === 'read' ? '✓✓' : item.status === 'delivered' ? '✓' : '•'}
          </Text>
        )}
      </View>
    </View>
  );

  const connBanner = connState !== 'connected' ? (
    <View style={s.banner}>
      {connState === 'reconnecting' || connState === 'connecting' ? (
        <>
          <ActivityIndicator size="small" color="#ff6b35" />
          <Text style={s.bannerText}>
            {connState === 'reconnecting' ? '重新连接中...' : '连接中...'}
          </Text>
        </>
      ) : (
        <Text style={s.bannerText}>未连接 · 消息将在重连后发送</Text>
      )}
    </View>
  ) : null;

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      {connBanner}
      <FlatList ref={flatRef} data={messages} keyExtractor={(i) => i.id} renderItem={renderItem}
        contentContainerStyle={s.list} onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: true })} />
      <View style={s.inputRow}>
        <TouchableOpacity style={s.imgBtn} onPress={sendImage} disabled={sending}>
          <Text style={s.imgBtnText}>{sending ? '⏳' : '🖼️'}</Text>
        </TouchableOpacity>
        <TextInput style={s.input} placeholder="说点什么..." placeholderTextColor="#666"
          value={input} onChangeText={setInput} onSubmitEditing={sendMessage} returnKeyType="send" />
        <TouchableOpacity style={s.sendBtn} onPress={sendMessage}>
          <Text style={s.sendText}>发送</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  banner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 6, backgroundColor: '#1a1a1a', gap: 8,
  },
  bannerText: { color: '#aaa', fontSize: 12 },
  list: { padding: 12, paddingBottom: 8 },
  bubble: { maxWidth: '75%', padding: 12, borderRadius: 16, marginBottom: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#ff6b35', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#1a1a1a', borderBottomLeftRadius: 4 },
  msgText: { color: '#fff', fontSize: 15 },
  chatImage: { width: 200, height: 200, borderRadius: 12, marginBottom: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 4, gap: 4 },
  time: { color: 'rgba(255,255,255,0.5)', fontSize: 10 },
  status: { color: 'rgba(255,255,255,0.7)', fontSize: 10 },
  inputRow: { flexDirection: 'row', padding: 8, borderTopWidth: 1, borderTopColor: '#1a1a1a', backgroundColor: '#0a0a0a', alignItems: 'center' },
  imgBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  imgBtnText: { fontSize: 22 },
  input: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#fff' },
  sendBtn: { backgroundColor: '#ff6b35', borderRadius: 20, paddingHorizontal: 20, justifyContent: 'center', marginLeft: 8 },
  sendText: { color: '#fff', fontWeight: '700' },
});
