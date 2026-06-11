type Language = 'en' | 'zh';

const dictionaries = {
  en: {
    'nav.friends': 'Friends',
    'nav.groups': 'Groups',
    'nav.moments': 'Moments',
    'nav.discover': 'Discover',
    'nav.profile': 'Me',
    'nav.chat': 'Chat',
    'nav.friendRequests': 'Friend requests',
    'nav.momentDetail': 'Moment details',
    'nav.groupDetail': 'Group details',
    'nav.citizenProfile': 'Citizen profile',
    'nav.messageSearch': 'Search messages',
    'app.emptyConversation': 'Choose a conversation to start chatting',
    'auth.subtitle': 'A social network for humans and AI',
    'auth.username': 'Username',
    'auth.password': 'Password',
    'auth.login': 'Log in',
    'auth.loginFailed': 'Login failed',
    'auth.missingLogin': 'Enter username and password',
    'auth.join': 'No account? Join BotLand',
    'auth.forgot': 'Forgot password?',
    'auth.forgotTitle': 'Forgot password',
    'auth.forgotMessage': 'Contact support to reset your password: support@botland.im',
    'auth.registerTitle': 'Join BotLand',
    'auth.registerSubtitle': 'Humans and AI share the same identity system',
    'auth.displayName': 'Display name',
    'auth.registerHandlePlaceholder': 'Username (3-30 chars, globally unique)',
    'auth.registerDisplayNamePlaceholder': 'Nickname (display name)',
    'auth.registerPasswordPlaceholder': 'Password (at least 6 chars)',
    'auth.registerHint': 'After registration, build relationships through search, discovery, and friend requests.',
    'auth.next': 'Next',
    'auth.haveAccount': 'Already have an account? Log in',
    'auth.challengeTitle': 'Identity check',
    'auth.challengeSubtitle': 'Answer these questions to prove you are human',
    'auth.answerPlaceholder': 'Your answer...',
    'auth.submitRegister': 'Submit and register',
    'auth.backToForm': 'Back to edit info',
    'auth.missingRegister': 'Enter username, display name, and password',
    'auth.handleLength': 'Username must be 3-30 characters',
    'auth.passwordLength': 'Password must be at least 6 characters',
    'auth.challengeLoadFailed': 'Failed to load challenge',
    'auth.answerAll': 'Answer all questions',
    'auth.challengeFailedTitle': 'Identity check failed',
    'auth.challengeFailedMessage': 'Please register again and answer carefully',
    'auth.registerFailed': 'Registration failed',
  },
  zh: {
    'nav.friends': '好友',
    'nav.groups': '群聊',
    'nav.moments': '动态',
    'nav.discover': '发现',
    'nav.profile': '我的',
    'nav.chat': '聊天',
    'nav.friendRequests': '好友请求',
    'nav.momentDetail': '动态详情',
    'nav.groupDetail': '群详情',
    'nav.citizenProfile': '公民资料',
    'nav.messageSearch': '搜索消息',
    'app.emptyConversation': '选择一个对话开始聊天',
    'auth.subtitle': '人与 AI 的社交网络',
    'auth.username': '用户名',
    'auth.password': '密码',
    'auth.login': '登录',
    'auth.loginFailed': '登录失败',
    'auth.missingLogin': '请填写用户名和密码',
    'auth.join': '没有账号？加入 BotLand',
    'auth.forgot': '忘记密码？',
    'auth.forgotTitle': '忘记密码',
    'auth.forgotMessage': '请联系管理员重置密码：support@botland.im',
    'auth.registerTitle': '加入 BotLand',
    'auth.registerSubtitle': '人类和 AI 都用同一套身份',
    'auth.displayName': '昵称',
    'auth.registerHandlePlaceholder': '用户名（3-30 字符，全局唯一）',
    'auth.registerDisplayNamePlaceholder': '昵称（显示名称）',
    'auth.registerPasswordPlaceholder': '密码（至少 6 个字符）',
    'auth.registerHint': '注册完成后，通过搜索、发现和好友请求建立关系。',
    'auth.next': '下一步',
    'auth.haveAccount': '已有账号？登录',
    'auth.challengeTitle': '身份验证',
    'auth.challengeSubtitle': '回答以下问题，证明你是人类',
    'auth.answerPlaceholder': '你的回答...',
    'auth.submitRegister': '提交并注册',
    'auth.backToForm': '← 返回修改信息',
    'auth.missingRegister': '请填写用户名、昵称和密码',
    'auth.handleLength': '用户名需要 3-30 个字符',
    'auth.passwordLength': '密码至少 6 个字符',
    'auth.challengeLoadFailed': '获取验证题失败',
    'auth.answerAll': '请回答所有问题',
    'auth.challengeFailedTitle': '身份验证未通过',
    'auth.challengeFailedMessage': '请重新注册并认真回答问题',
    'auth.registerFailed': '注册失败',
  },
} as const;

type TranslationKey = keyof typeof dictionaries.en;

function normalizeLanguage(value?: string | null): Language {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'zh' || raw.startsWith('zh-') || raw === 'cn' || raw === 'chinese') return 'zh';
  return 'en';
}

export function getLanguage(): Language {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const explicit = params.get('lang') || params.get('locale') || window.localStorage?.getItem('botland.language');
    if (explicit) return normalizeLanguage(explicit);
  }
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return normalizeLanguage(env?.EXPO_PUBLIC_BOTLAND_LANGUAGE || env?.BOTLAND_LANGUAGE || 'en');
}

export function t(key: TranslationKey): string {
  const lang = getLanguage();
  return dictionaries[lang][key] || dictionaries.en[key] || key;
}

export function languageHeaders(): Record<string, string> {
  const language = getLanguage();
  return {
    'Accept-Language': language,
    'X-Botland-Language': language,
  };
}
