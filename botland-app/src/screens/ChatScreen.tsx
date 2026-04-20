import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { createWebSocket } from '../services/api';
import auth from '../services/auth';

type Message = { id: string; from: string; text: string; mine: boolean; time: string };
type Props = { route: any };

export default function ChatScreen({ route }: Props) {
  const { friendId, friendName } = route.params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string>('');
  const flatRef = useRef<FlatList>(null);

  useEffect(() => {
    let ws: WebSocket;
    (async () => {
      const token = await auth.getAccessToken();
      const myId = await auth.getCitizenId();
      if (!token || !myId) return;
      myIdRef.current = myId;

      ws = createWebSocket(token);
      wsRef.current = ws;

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'message.received' && data.from === friendId) {
            const msg: Message = {
              id: data.id || Date.now().toString(),
              from: data.from,
              text: data.payload?.text || '',
              mine: false,
              time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            };
            setMessages((prev) => [...prev, msg]);
          }
        } catch {}
      };
    })();

    return () => { ws?.close(); };
  }, [friendId]);

  const sendMessage = () => {
    if (!input.trim() || !wsRef.current) return;
    const id = `msg_${Date.now()}`;
    const msg: Message = { id, from: myIdRef.current, text: input, mine: true, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) };
    wsRef.current.send(JSON.stringify({ type: 'message.send', id, to: friendId, payload: { content_type: 'text', text: input } }));
    setMessages((prev) => [...prev, msg]);
    setInput('');
  };

  const renderItem = ({ item }: { item: Message }) => (
    <View style={[s.bubble, item.mine ? s.mine : s.theirs]}>
      <Text style={s.msgText}>{item.text}</Text>
      <Text style={s.time}>{item.time}</Text>
    </View>
  );

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FlatList
        ref={flatRef}
        data={messages}
        keyExtractor={(i) => i.id}
        renderItem={renderItem}
        contentContainerStyle={s.list}
        onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: true })}
      />
      <View style={s.inputRow}>
        <TextInput style={s.input} placeholder="说点什么..." placeholderTextColor="#666" value={input} onChangeText={setInput} onSubmitEditing={sendMessage} returnKeyType="send" />
        <TouchableOpacity style={s.sendBtn} onPress={sendMessage}>
          <Text style={s.sendText}>发送</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  list: { padding: 12, paddingBottom: 8 },
  bubble: { maxWidth: '75%', padding: 12, borderRadius: 16, marginBottom: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#ff6b35', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#1a1a1a', borderBottomLeftRadius: 4 },
  msgText: { color: '#fff', fontSize: 15 },
  time: { color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 4, alignSelf: 'flex-end' },
  inputRow: { flexDirection: 'row', padding: 8, borderTopWidth: 1, borderTopColor: '#1a1a1a', backgroundColor: '#0a0a0a' },
  input: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#fff' },
  sendBtn: { backgroundColor: '#ff6b35', borderRadius: 20, paddingHorizontal: 20, justifyContent: 'center', marginLeft: 8 },
  sendText: { color: '#fff', fontWeight: '700' },
});
