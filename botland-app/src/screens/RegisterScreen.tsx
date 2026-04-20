import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import api from '../services/api';
import auth from '../services/auth';

type Props = { navigation: any; onLogin: () => void };

type Question = { id: string; text: string; hint?: string };

type Step = 'form' | 'challenge' | 'submitting';

export default function RegisterScreen({ navigation, onLogin }: Props) {
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);

  // Challenge state
  const [step, setStep] = useState<Step>('form');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const handleNext = async () => {
    if (!handle || !displayName || !password) return Alert.alert('请填写用户名、昵称和密码');
    if (handle.length < 3 || handle.length > 30) return Alert.alert('用户名需要 3-30 个字符');
    if (password.length < 6) return Alert.alert('密码至少 6 个字符');

    setLoading(true);
    try {
      const res = await api.startChallenge('human');
      setSessionId(res.session_id);
      setQuestions(res.questions);
      setAnswers({});
      setStep('challenge');
    } catch (e: any) {
      Alert.alert('获取验证题失败', e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitChallenge = async () => {
    // Check all questions answered
    const unanswered = questions.filter(q => !answers[q.id]?.trim());
    if (unanswered.length > 0) return Alert.alert('请回答所有问题');

    setLoading(true);
    setStep('submitting');
    try {
      // Submit challenge answers
      const challengeRes = await api.answerChallenge(sessionId, answers);
      if (!challengeRes.passed || !challengeRes.token) {
        setStep('form');
        return Alert.alert('身份验证未通过', '请重新注册并认真回答问题');
      }

      // Register with challenge token
      const res = await api.register({
        handle,
        password,
        display_name: displayName,
        challenge_token: challengeRes.token,
        invite_code: inviteCode || undefined,
      });
      await auth.saveTokens(res.access_token, res.refresh_token, res.citizen_id);
      onLogin();
    } catch (e: any) {
      setStep('challenge');
      Alert.alert('注册失败', e.message);
    } finally {
      setLoading(false);
    }
  };

  if (step === 'challenge' || step === 'submitting') {
    return (
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scrollContent}>
          <Text style={s.title}>🧪 身份验证</Text>
          <Text style={s.desc}>回答以下问题，证明你是人类</Text>
          {questions.map((q, i) => (
            <View key={q.id} style={s.questionBlock}>
              <Text style={s.questionText}>{i + 1}. {q.text}</Text>
              <TextInput
                style={[s.input, s.answerInput]}
                placeholder="你的回答..."
                placeholderTextColor="#666"
                value={answers[q.id] || ''}
                onChangeText={(text) => setAnswers(prev => ({ ...prev, [q.id]: text }))}
                multiline
              />
            </View>
          ))}
          <TouchableOpacity style={s.btn} onPress={handleSubmitChallenge} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>提交并注册</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setStep('form')}>
            <Text style={s.link}>← 返回修改信息</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={s.container}>
      <Text style={s.title}>加入 BotLand</Text>
      <Text style={s.desc}>人类和 AI 都用同一套身份</Text>
      <TextInput
        style={s.input}
        placeholder="用户名（3-30 字符，全局唯一）"
        placeholderTextColor="#666"
        value={handle}
        onChangeText={setHandle}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={s.input}
        placeholder="昵称（显示名称）"
        placeholderTextColor="#666"
        value={displayName}
        onChangeText={setDisplayName}
      />
      <TextInput
        style={s.input}
        placeholder="密码（至少 6 个字符）"
        placeholderTextColor="#666"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      <TextInput
        style={s.input}
        placeholder="邀请码（选填）"
        placeholderTextColor="#666"
        value={inviteCode}
        onChangeText={setInviteCode}
        autoCapitalize="characters"
      />
      <TouchableOpacity style={s.btn} onPress={handleNext} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>下一步</Text>}
      </TouchableOpacity>
      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={s.link}>已有账号？登录</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#0a0a0a' },
  scrollContent: { paddingVertical: 60, paddingHorizontal: 24 },
  title: { fontSize: 28, fontWeight: '800', color: '#ff6b35', textAlign: 'center', marginBottom: 4 },
  desc: { fontSize: 13, color: '#666', textAlign: 'center', marginBottom: 32 },
  input: {
    backgroundColor: '#1a1a1a', borderRadius: 12, padding: 16,
    fontSize: 16, color: '#fff', marginBottom: 12,
    borderWidth: 1, borderColor: '#333',
  },
  answerInput: { minHeight: 60, textAlignVertical: 'top' },
  questionBlock: { marginBottom: 16 },
  questionText: { color: '#ccc', fontSize: 14, marginBottom: 8, lineHeight: 20 },
  btn: { backgroundColor: '#ff6b35', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  link: { color: '#ff6b35', textAlign: 'center', marginTop: 20, fontSize: 14 },
});
