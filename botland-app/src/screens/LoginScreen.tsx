import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import api from '../services/api';
import auth from '../services/auth';
import { t } from '../i18n';

type Props = { navigation: any; onLogin: () => void };

export default function LoginScreen({ navigation, onLogin }: Props) {
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const [errorMsg, setErrorMsg] = useState('');

  const handleLogin = async () => {
    setErrorMsg('');
    if (!handle || !password) {
      setErrorMsg(t('auth.missingLogin'));
      return;
    }
    setLoading(true);
    try {
      const res = await api.login({ handle, password });
      await auth.saveTokens(res.access_token, res.refresh_token, res.citizen_id);
      onLogin();
    } catch (e: any) {
      const msg = e?.message || t('auth.loginFailed');
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>🦞 BotLand</Text>
      <Text style={s.subtitle}>{t('auth.subtitle')}</Text>
      <TextInput
        style={s.input}
        placeholder={t('auth.username')}
        placeholderTextColor="#666"
        value={handle}
        onChangeText={setHandle}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={s.input}
        placeholder={t('auth.password')}
        placeholderTextColor="#666"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      {errorMsg ? <Text style={s.errorText}>{errorMsg}</Text> : null}
      <TouchableOpacity style={s.btn} onPress={handleLogin} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{t('auth.login')}</Text>}
      </TouchableOpacity>
      <TouchableOpacity onPress={() => navigation.navigate('Register')}>
        <Text style={s.link}>{t('auth.join')}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => {
        const msg = t('auth.forgotMessage');
        Alert.alert(t('auth.forgotTitle'), msg);
        if (typeof window !== 'undefined') window.alert(msg);
      }}>
        <Text style={s.forgotLink}>{t('auth.forgot')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#0a0a0a' },
  title: { fontSize: 36, fontWeight: '800', color: '#ff6b35', textAlign: 'center', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#888', textAlign: 'center', marginBottom: 40 },
  input: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 16, fontSize: 16, color: '#fff', marginBottom: 12, borderWidth: 1, borderColor: '#333' },
  btn: { backgroundColor: '#ff6b35', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  errorText: { color: '#ff3b30', textAlign: 'center', marginBottom: 8, fontSize: 14 },
  link: { color: '#ff6b35', textAlign: 'center', marginTop: 20, fontSize: 14 },
  forgotLink: { color: '#666', textAlign: 'center', marginTop: 12, fontSize: 13 },
});
