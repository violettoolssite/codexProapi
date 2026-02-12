import { randomBytes, createHash } from 'crypto';

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const STATE_TTL_MS = 10 * 60 * 1000;

const stateStore = new Map();

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 生成 PKCE code_verifier 与 code_challenge (S256)
 */
function generatePKCE() {
  const code_verifier = base64UrlEncode(randomBytes(32));
  const challenge = createHash('sha256').update(code_verifier).digest();
  const code_challenge = base64UrlEncode(challenge);
  return { code_verifier, code_challenge };
}

/**
 * 生成随机 state
 */
function generateState() {
  return base64UrlEncode(randomBytes(24));
}

/**
 * 清理过期 state
 */
function pruneState() {
  const now = Date.now();
  for (const [state, data] of stateStore.entries()) {
    if (now - data.createdAt > STATE_TTL_MS) stateStore.delete(state);
  }
}

/**
 * 构建授权 URL 并保存 state 对应的 code_verifier
 * @param {string} redirectUri - 回调地址，例如 http://localhost:8888/auth/callback
 */
export function getAuthorizeUrl(redirectUri) {
  pruneState();
  const { code_verifier, code_challenge } = generatePKCE();
  const state = generateState();
  stateStore.set(state, { code_verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: code_challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'login',
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, state };
}

/**
 * 用授权码换取 token，并解析出 access_token、account_id
 */
export async function exchangeCodeForToken(code, redirectUri, state) {
  const data = stateStore.get(state);
  if (!data) throw new Error('Invalid or expired state');
  stateStore.delete(state);

  const code_verifier = data.code_verifier;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: code_verifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    let errMsg = `Token exchange failed: ${res.status}`;
    try {
      const errJson = JSON.parse(text);
      if (errJson.error) errMsg += ` ${errJson.error}`;
      if (errJson.error_description) errMsg += ` - ${errJson.error_description}`;
    } catch (_) {
      if (text) errMsg += ` ${text.slice(0, 200)}`;
    }
    throw new Error(errMsg);
  }

  const json = await res.json();
  const access_token = json.access_token;
  if (!access_token) throw new Error('No access_token in response');

  let account_id = json.account_id || json.user?.id || json.user_id;
  let email = json.user?.email || json.email || null;

  if (json.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(json.id_token.split('.')[1], 'base64url').toString()
      );
      if (!account_id) account_id = payload.sub || payload.account_id || payload.user_id;
      if (!email) email = payload.email || null;
      if (!email && (payload.name || payload.preferred_username)) {
        email = payload.name || payload.preferred_username;
      }
    } catch (_) {}
  }
  if (!account_id) account_id = json.sub || 'unknown';

  return { access_token, account_id, refresh_token: json.refresh_token, email };
}
