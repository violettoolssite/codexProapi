import express from 'express';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
import { isAccountUnavailable } from './accountStatus.js';
import { getRemainingPct, getUsedTokens, QUOTA } from './usageTracker.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const app = express();
// 默认信任反向代理，使 X-Forwarded-Proto / X-Forwarded-Host 生效，绑定时 OAuth 回调地址与用户访问地址一致
app.set('trust proxy', true);
const PORT = Number(process.env.PORT) || 1455;
const AUTH_PATH = process.env.CODEX_AUTH_PATH || null;
const EMAIL_SERVICE_URL = (process.env.EMAIL_SERVICE_URL || 'https://kami666.xyz').replace(/\/$/, '');
const ONECLICK_DOMAINS = ['qxfy.store', 'deploytools.site', 'loginvipcursor.icu', 'kami666.xyz', 'free.202602dashi27.top'];

function getConfigPath() {
  return join(dirname(getAccountsPath()), 'config.json');
}
function loadConfig() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const j = JSON.parse(raw);
    return { api_key: typeof j.api_key === 'string' ? j.api_key : '' };
  } catch {
    return { api_key: '' };
  }
}
function saveConfig(obj) {
  const p = getConfigPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify({ api_key: obj.api_key ?? '' }, null, 2), 'utf8');
}

function randomLocalPart(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function emailInboxHasMail(serviceUrl, email) {
  try {
    const r = await fetch(`${serviceUrl}/api/emails/${encodeURIComponent(email)}`, { method: 'GET' });
    if (!r.ok) return false;
    const data = await r.json().catch(() => ({}));
    const count = data.count != null ? data.count : (data.emails && data.emails.length) || 0;
    return count > 0;
  } catch {
    return false;
  }
}

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

// 版本号以 package.json 为准，供前端统一显示
try {
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  app.get('/api/version', (req, res) => res.json({ version: pkg.version || '0.0.0' }));
} catch {
  app.get('/api/version', (req, res) => res.json({ version: '0.0.0' }));
}

app.use(express.static(join(__dirname, '..', 'public')));

const requestLogs = [];
const MAX_LOGS = 200;
const LOG_PATHS = ['/health', '/v1/models', '/v1/chat/completions', '/chat/completions', '/responses'];

app.use((req, res, next) => {
  if (!LOG_PATHS.includes(req.path)) return next();
  const start = Date.now();
  res._logMeta = { time: new Date().toISOString(), method: req.method, path: req.path };
  res.on('finish', () => {
    const status = res.statusCode;
    const level = status >= 500 ? 'ERR' : status >= 400 ? 'WARN' : 'SUCCESS';
    requestLogs.unshift({
      type: 'request',
      level,
      ...res._logMeta,
      status,
      ms: Date.now() - start,
    });
    if (requestLogs.length > MAX_LOGS) requestLogs.pop();
  });
  next();
});

const API_KEY_PATHS = ['/v1/models', '/v1/chat/completions', '/chat/completions', '/responses'];
app.use((req, res, next) => {
  if (!API_KEY_PATHS.includes(req.path)) return next();
  const cfg = loadConfig();
  if (!cfg.api_key || String(cfg.api_key).trim() === '') return next();
  const auth = req.headers.authorization;
  const token = (auth && String(auth).startsWith('Bearer ')) ? String(auth).slice(7).trim() : '';
  if (token !== cfg.api_key) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
});

function getOAuthRedirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI.trim();
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (publicUrl) return `${publicUrl}/auth/callback`;
  const rawProto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  const proto = (typeof rawProto === 'string' ? rawProto.split(',')[0].trim() : rawProto) || 'http';
  const rawHost = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  let host = (typeof rawHost === 'string' ? rawHost.split(',')[0].trim() : rawHost) || `localhost:${PORT}`;
  if (/^127\.0\.0\.1(:\d+)?$/i.test(host)) host = host.replace(/^127\.0\.0\.1/i, 'localhost');
  return `${proto}://${host}/auth/callback`;
}

const OPENAI_CREATE_ACCOUNT_URL = 'https://auth.openai.com/create-account';

app.get('/auth/login', (req, res) => {
  const redirectUri = getOAuthRedirectUri(req);
  const { url } = getAuthorizeUrl(redirectUri);
  res.redirect(302, url);
});

app.get('/auth/create-account', (req, res) => {
  res.redirect(302, OPENAI_CREATE_ACCOUNT_URL);
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
    console.error('OAuth callback error:', e.message, '| redirect_uri:', redirectUri);
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
  const { accounts } = listAccountsForApi();
  const accountCount = accounts.length || 1;
  const usedAuth = await handleChatCompletions(req.body, res, getAuthProvider, accountCount);
  if (res._logMeta && usedAuth) {
    const mask = usedAuth.accountId ? usedAuth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
});

app.post('/chat/completions', async (req, res) => {
  const { accounts } = listAccountsForApi();
  const accountCount = accounts.length || 1;
  const usedAuth = await handleChatCompletions(req.body, res, getAuthProvider, accountCount);
  if (res._logMeta && usedAuth) {
    const mask = usedAuth.accountId ? usedAuth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
});

// 兼容将 Base URL 设为根且请求 /responses 的客户端（如部分 ChatGPT 风格客户端）
app.post('/responses', async (req, res) => {
  const { accounts } = listAccountsForApi();
  const accountCount = accounts.length || 1;
  const usedAuth = await handleChatCompletions(req.body, res, getAuthProvider, accountCount);
  if (res._logMeta && usedAuth) {
    const mask = usedAuth.accountId ? usedAuth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: requestLogs });
});
app.delete('/api/logs', (req, res) => {
  requestLogs.length = 0;
  res.json({ ok: true });
});

app.get('/api/usage', async (req, res) => {
  try {
    const auths = loadAccountsForProxy();
    const result = [];
    for (let i = 0; i < auths.length; i++) {
      const auth = auths[i];
      if (auth.type !== 'codex' || !auth.accessToken) {
        result.push({ index: i, remaining_pct: null, used_tokens: null });
        continue;
      }
      if (isAccountUnavailable(auth.accountId)) {
        result.push({ index: i, remaining_pct: 0, used_tokens: 0 });
        continue;
      }
      result.push({
        index: i,
        remaining_pct: getRemainingPct(auth.accountId),
        used_tokens: getUsedTokens(auth.accountId),
        quota_tokens: QUOTA,
      });
    }
    res.json({ accounts: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/oneclick/email', async (req, res) => {
  let domainList = ONECLICK_DOMAINS;
  try {
    const r = await fetch(`${EMAIL_SERVICE_URL}/api/domains`, { method: 'GET' });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      const fromApi = data.domains && Array.isArray(data.domains) ? data.domains : [];
      if (fromApi.length > 0) {
        domainList = fromApi.map((d) => (d.name || (d.api || '').replace(/^https?:\/\//, '').split('/')[0]).trim()).filter(Boolean);
        if (domainList.length === 0) domainList = ONECLICK_DOMAINS;
      }
    }
  } catch (_) {}
  const maxTries = 15;
  for (let i = 0; i < maxTries; i++) {
    const domain = pickRandom(domainList);
    const local = randomLocalPart(10);
    const email = `${local}@${domain}`;
    const hasMail = await emailInboxHasMail(EMAIL_SERVICE_URL, email);
    if (!hasMail) {
      return res.json({ email });
    }
  }
  const domain = pickRandom(domainList);
  res.json({ email: `${randomLocalPart(10)}@${domain}` });
});

function extractVerificationCodeFromEmail(emailObj) {
  if (emailObj.verificationCode) return emailObj.verificationCode;
  const text = [emailObj.subject, emailObj.text, emailObj.html].filter(Boolean).join(' ');
  const m = text.match(/\b(\d{6})\b/) || text.match(/代码[为為是为]?\s*(\d{6})/i) || text.match(/验证码[：:]\s*(\d{6})/i) || text.match(/code[:\s]+(\d{6})/i);
  return m ? m[1] : null;
}

app.get('/api/oneclick/emails/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    const r = await fetch(`${EMAIL_SERVICE_URL}/api/emails/${encodeURIComponent(email)}`, { method: 'GET' });
    const data = !r.ok ? { emails: [] } : await r.json().catch(() => ({}));
    const emails = data.emails || [];
    for (let i = 0; i < emails.length; i++) {
      if (!emails[i].verificationCode) {
        const code = extractVerificationCodeFromEmail(emails[i]);
        if (code) emails[i].verificationCode = code;
      }
    }
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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

app.get('/api/settings', (req, res) => {
  try {
    res.json(loadConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/settings', (req, res) => {
  try {
    const api_key = typeof req.body?.api_key === 'string' ? req.body.api_key : '';
    const current = loadConfig();
    current.api_key = api_key;
    saveConfig(current);
    res.json({ ok: true, api_key: current.api_key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function startServer() {
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
  const server = app.listen(PORT, '0.0.0.0', () => {
    const mockReq = { get: (h) => (h === 'host' ? `localhost:${PORT}` : undefined), secure: false };
    const oauthRedirect = getOAuthRedirectUri(mockReq);
    console.log('\nCodex Pro API 已启动 http://0.0.0.0:' + PORT);
    console.log('   配置页（添加账号）: http://localhost:' + PORT + '/');
    console.log('   健康检查: http://localhost:' + PORT + '/health');
    console.log('   OAuth 回调（绑定 API 用）: ' + oauthRedirect + (process.env.PUBLIC_URL || process.env.OAUTH_REDIRECT_URI ? ' (已用 PUBLIC_URL/OAUTH_REDIRECT_URI)' : ' (若绑定时 403 请设置 PUBLIC_URL)'));
    console.log('   对话接口: http://localhost:' + PORT + '/v1/chat/completions');
    console.log('   建议模型: gpt-5.3-codex\n');
  });

  setInterval(() => {
    if (loadAccountsForProxy().length > 1) {
      requestLogs.unshift({
        type: 'system',
        level: 'INFO',
        time: new Date().toISOString(),
        method: '',
        pathKey: 'logs.system',
        path: '',
        status: '',
        ms: '',
        messageKey: 'logs.poll_status',
        account: '',
      });
      if (requestLogs.length > MAX_LOGS) requestLogs.pop();
    }
  }, 5000);
  return server;
}

export { app, startServer, PORT };

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === new URL(import.meta.url).href;
if (isMain) {
  startServer();
}
