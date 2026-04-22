import React, { useState, useCallback } from 'react';
import { View, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import api from '../services/api';

type BotCardData = {
  id: string;
  slug: string;
  code: string;
  bot: { id: string; slug?: string; name: string; avatar?: string; summary?: string };
  human_url: string;
  agent_url?: string;
  skill_slug?: string;
  status: string;
};

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  onResolved?: (card: BotCardData | null) => void;
  placeholder?: string;
};

export default function BotCardInput({ value, onChangeText, onResolved, placeholder }: Props) {
  const [resolving, setResolving] = useState(false);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback((text: string) => {
    onChangeText(text);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 4) {
      onResolved?.(null);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setResolving(true);
      try {
        const res = await api.resolveBotCard(trimmed);
        onResolved?.(res.card);
      } catch {
        onResolved?.(null);
      } finally {
        setResolving(false);
      }
    }, 600);
  }, [onChangeText, onResolved]);

  return (
    <View style={styles.wrapper}>
      <TextInput
        style={styles.input}
        placeholder={placeholder || '输入 Bot 名片码或名片链接（选填）'}
        placeholderTextColor="#666"
        value={value}
        onChangeText={handleChange}
        autoCapitalize="characters"
      />
      {resolving && <ActivityIndicator style={styles.spinner} size="small" color="#ff6b35" />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'relative' },
  input: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: '#fff',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#333',
  },
  spinner: { position: 'absolute', right: 16, top: 18 },
});
