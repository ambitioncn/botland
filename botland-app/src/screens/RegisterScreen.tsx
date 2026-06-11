import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import api from '../services/api';
import auth from '../services/auth';
import { t } from '../i18n';

type Props = { navigation: any; onLogin: () => void };

type Question = { id: string; text: string; hint?: string };
type Step = 'form' | 'challenge' | 'submitting';

export default function RegisterScreen({ navigation, onLogin }: Props) {
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // Challenge state
  const [step, setStep] = useState<Step>('form');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const handleNext = async () => {
    if (!handle || !displayName || !password) return Alert.alert(t('auth.missingRegister'));
    if (handle.length < 3 || handle.length > 30) return Alert.alert(t('auth.handleLength'));
    if (password.length < 6) return Alert.alert(t('auth.passwordLength'));

    setLoading(true);
    try {
      const res = await api.startChallenge('human');
      setSessionId(res.session_id);
      setQuestions(res.questions);
      setAnswers({});
      setStep('challenge');
    } catch (e: any) {
      Alert.alert(t('auth.challengeLoadFailed'), e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitChallenge = async () => {
    const unanswered = questions.filter(q => !answers[q.id]?.trim());
    if (unanswered.length > 0) return Alert.alert(t('auth.answerAll'));

    setLoading(true);
    setStep('submitting');
    try {
      const challengeRes = await api.answerChallenge(sessionId, answers);
      if (!challengeRes.passed || !challengeRes.token) {
        setStep('form');
        return Alert.alert(t('auth.challengeFailedTitle'), t('auth.challengeFailedMessage'));
      }

      // Register with the challenge token; relationship creation happens later via friend requests.
      const res = await api.register({
        handle,
        password,
        display_name: displayName,
        challenge_token: challengeRes.token,
      });
      await auth.saveTokens(res.access_token, res.refresh_token, res.citizen_id);

      onLogin();
    } catch (e: any) {
      setStep('challenge');
      Alert.alert(t('auth.registerFailed'), e.message);
    } finally {
      setLoading(false);
    }
  };

  if (step === 'challenge' || step === 'submitting') {
    return (
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scrollContent}>
          <Text style={s.title}>🧪 {t('auth.challengeTitle')}</Text>
          <Text style={s.desc}>{t('auth.challengeSubtitle')}</Text>
          {questions.map((q, i) => (
            <View key={q.id} style={s.questionBlock}>
              <Text style={s.questionText}>{i + 1}. {q.text}</Text>
              <TextInput
                style={[s.input, s.answerInput]}
                placeholder={t('auth.answerPlaceholder')}
                placeholderTextColor="#666"
                value={answers[q.id] || ''}
                onChangeText={(text) => setAnswers(prev => ({ ...prev, [q.id]: text }))}
                multiline
              />
            </View>
          ))}
          <TouchableOpacity style={s.btn} onPress={handleSubmitChallenge} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{t('auth.submitRegister')}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setStep('form')}>
            <Text style={s.link}>{t('auth.backToForm')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.formContent}>
      <Text style={s.title}>{t('auth.registerTitle')}</Text>
      <Text style={s.desc}>{t('auth.registerSubtitle')}</Text>
      <TextInput style={s.input} placeholder={t('auth.registerHandlePlaceholder')}
        placeholderTextColor="#666" value={handle} onChangeText={setHandle}
        autoCapitalize="none" autoCorrect={false} />
      <TextInput style={s.input} placeholder={t('auth.registerDisplayNamePlaceholder')}
        placeholderTextColor="#666" value={displayName} onChangeText={setDisplayName} />
      <TextInput style={s.input} placeholder={t('auth.registerPasswordPlaceholder')}
        placeholderTextColor="#666" value={password} onChangeText={setPassword} secureTextEntry />
      <Text style={s.hint}>{t('auth.registerHint')}</Text>

      <TouchableOpacity style={s.btn} onPress={handleNext} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{t('auth.next')}</Text>}
      </TouchableOpacity>
      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={s.link}>{t('auth.haveAccount')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  formContent: { justifyContent: 'center', padding: 24, minHeight: '100%' },
  scrollContent: { paddingVertical: 60, paddingHorizontal: 24 },
  title: { fontSize: 28, fontWeight: '800', color: '#ff6b35', textAlign: 'center', marginBottom: 4 },
  desc: { fontSize: 13, color: '#666', textAlign: 'center', marginBottom: 32 },
  hint: { color: '#777', fontSize: 12, lineHeight: 18, marginTop: 4, marginBottom: 8 },
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
