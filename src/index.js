import express from 'express';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadAuth, createRoundRobinProvider } from './auth.js';
import { handleChatCompletions } from './proxy.js';
import {
  listAccountsForApi,
  addAccount,
  deleteAccount,
  loadAccountsForProxy,
  getAccountsPath,
} from './accounts.js';
import { getAuthorizeUrl, exchangeCodeForToken } from './oauth.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 1455;
const AUTH_PATH = process.env.CODEX_AUTH_PATH || null;

// 当前使用的认证来源：function（轮询）或 string（单路径）
let authProviderRef = { current: null };

function getAuthProvider() {
  const p = authProviderRef.current;
  if (typeof p === 'function') return p();
  return loadAuth(p);
}

function refreshAuthProvider() {
  const auths = loadAccountsForProxy();
  if (auths.length > 0) {
    authProviderRef.current = createRoundRobinProvider(auths);
    return auths.length;
  }
  authProviderRef.current = AUTH_PATH;
  return 0;
}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(join(__dirname, '..', 'public')));

const requestLogs = [];
const MAX_LOGS = 200;
const LOG_PATHS = ['/health', '/v1/models', '/v1/chat/completions', '/chat/completions'];

app.use((req, res, next) => {
  if (!LOG_PATHS.includes(req.path)) return next();
  const start = Date.now();
  res._logMeta = { time: new Date().toISOString(), method: req.method, path: req.path };
  res.on('finish', () => {
    requestLogs.unshift({
      ...res._logMeta,
      status: res.statusCode,
      ms: Date.now() - start,
    });
    if (requestLogs.length > MAX_LOGS) requestLogs.pop();
  });
  next();
});

function getOAuthRedirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI.trim();
  const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  let host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  // 使用 127.0.0.1 时 OAuth 常报 unknown_error，因后台只允许 localhost；统一为 localhost
  if (/^127\.0\.0\.1(:\d+)?$/i.test(host)) host = host.replace(/^127\.0\.0\.1/i, 'localhost');
  return `${proto}://${host}/auth/callback`;
}

app.get('/auth/login', (req, res) => {
  const redirectUri = getOAuthRedirectUri(req);
  const { url } = getAuthorizeUrl(redirectUri);
  res.redirect(302, url);
});

app.get('/auth/callback', async (req, res) => {
  const redirectUri = getOAuthRedirectUri(req);
  const { code, state, error: oauthError, error_description: oauthDesc } = req.query;
  if (oauthError) {
    const msg = [oauthError, oauthDesc].filter(Boolean).join(': ');
    console.error('OAuth error from provider:', msg);
    res.redirect(302, `/?oauth=error&msg=${encodeURIComponent(msg || 'oauth_error')}#/accounts`);
    return;
  }
  if (!code || !state) {
    res.redirect(302, `/?oauth=error&msg=${encodeURIComponent('missing_code_or_state')}#/accounts`);
    return;
  }
  try {
    const { access_token, account_id, email } = await exchangeCodeForToken(code, redirectUri, state);
    addAccount({ access_token, account_id, source: 'oauth', name: email || undefined });
    refreshAuthProvider();
    res.redirect(302, '/?oauth=success');
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.redirect(302, `/?oauth=error&msg=${encodeURIComponent(e.message)}#/accounts`);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'codex-proapi' });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'gpt-5.3-codex', object: 'model', created: 1687882411, owned_by: 'openai' },
      { id: 'gpt-5.2-codex', object: 'model', created: 1687882411, owned_by: 'openai' },
      { id: 'gpt-5-codex', object: 'model', created: 1687882411, owned_by: 'openai' },
      { id: 'gpt-5', object: 'model', created: 1687882411, owned_by: 'openai' },
      { id: 'gpt-4', object: 'model', created: 1687882411, owned_by: 'openai' },
    ],
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const auth = getAuthProvider();
  if (res._logMeta) {
    const { accounts } = listAccountsForApi();
    const mask = auth.accountId ? auth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
  await handleChatCompletions(req.body, res, () => auth);
});

app.post('/chat/completions', async (req, res) => {
  const auth = getAuthProvider();
  if (res._logMeta) {
    const { accounts } = listAccountsForApi();
    const mask = auth.accountId ? auth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
  await handleChatCompletions(req.body, res, () => auth);
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: requestLogs });
});

app.get('/api/accounts', (req, res) => {
  try {
    res.json(listAccountsForApi());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts', (req, res) => {
  try {
    addAccount(req.body);
    refreshAuthProvider();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/accounts/:index', (req, res) => {
  try {
    deleteAccount(req.params.index);
    refreshAuthProvider();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function main() {
  const n = refreshAuthProvider();
  if (n > 0) {
    console.log('[OK] 已加载 ' + n + ' 个账号（轮询）');
  } else {
    try {
      loadAuth(AUTH_PATH);
      console.log('[OK] 已加载 Codex 认证（单账号）');
    } catch (e) {
      console.warn('[WARN] 未配置账号，请访问配置页添加或设置 CODEX_AUTH_PATH:', e.message);
    }
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log('\nCodex Pro API 已启动 http://0.0.0.0:' + PORT);
    console.log('   配置页（添加账号）: http://localhost:' + PORT + '/');
    console.log('   健康检查: http://localhost:' + PORT + '/health');
    console.log('   对话接口: http://localhost:' + PORT + '/v1/chat/completions');
    console.log('   建议模型: gpt-5.3-codex\n');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
