import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import api, { DraftSocialActionBody } from '../services/api';
import auth from '../services/auth';

type ActionType = 'welcome' | 'praise' | 'question' | 'comfort' | 'joke' | 'invite';

type Props = {
  sourceType: 'community_post' | 'community_reply' | 'moment' | 'citizen' | string;
  sourceId: string;
  targetCitizenId?: string;
  actions?: ActionType[];
  compact?: boolean;
  onDraft: (draft: string, actionType: ActionType) => void;
};

const actionLabels: Record<ActionType, string> = {
  welcome: '欢迎',
  praise: '夸夸',
  question: '追问',
  comfort: '安慰',
  joke: '接梗',
  invite: '邀请',
};

const defaultActions: ActionType[] = ['praise', 'question', 'comfort', 'joke', 'invite'];

export default function SocialActionBar({ sourceType, sourceId, targetCitizenId, actions = defaultActions, compact, onDraft }: Props) {
  const [loadingAction, setLoadingAction] = useState<ActionType | null>(null);

  const handlePress = async (actionType: ActionType) => {
    if (loadingAction) return;
    const token = await auth.getAccessToken();
    if (!token) return;
    setLoadingAction(actionType);
    try {
      const body: DraftSocialActionBody = {
        action_type: actionType,
        source_type: sourceType,
        source_id: sourceId,
        target_citizen_id: targetCitizenId,
      };
      const res = await api.draftSocialAction(token, body);
      onDraft(res.draft, actionType);
    } catch (e: any) {
      Alert.alert('生成草稿失败', e?.message || '未知错误');
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <View style={[s.container, compact && s.compactContainer]}>
      {!compact ? <Text style={s.label}>你可以：</Text> : null}
      <View style={s.actions}>
        {actions.map(action => (
          <TouchableOpacity key={action} style={s.chip} onPress={() => handlePress(action)} disabled={!!loadingAction} activeOpacity={0.8}>
            <Text style={s.chipText}>{loadingAction === action ? '...' : actionLabels[action]}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#222' },
  compactContainer: { marginTop: 0, paddingTop: 0, borderTopWidth: 0 },
  label: { color: '#666', fontSize: 12, marginBottom: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#1a1a1a', borderColor: '#333', borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 7 },
  chipText: { color: '#ff6b35', fontSize: 12, fontWeight: '700' },
});
