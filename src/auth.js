import { readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

const DEFAULT_AUTH_PATH = resolve(homedir(), '.codex', 'auth.json');

/**
 * 解析 auth 路径：支持 ~/.codex/auth.json 与绝对路径
 */
function resolveAuthPath(given) {
  if (!given) return DEFAULT_AUTH_PATH;
  if (given.startsWith('~/')) return resolve(homedir(), given.slice(2));
  return resolve(given);
}

/**
 * 从 Codex auth.json 加载认证信息
 * 支持格式：
 * - { access_token, account_id } 或 { tokens: { access_token, account_id } }（ChatGPT/Codex）
 * - { api_key } 或 { OPENAI_API_KEY }（OpenAI API Key）
 */
export function loadAuth(authPath = null) {
  const path = resolveAuthPath(authPath || process.env.CODEX_AUTH_PATH);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`无法读取认证文件: ${path} (${e.message})`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`auth.json 格式错误: ${e.message}`);
  }
  const tokens = data.tokens || (data.access_token ? { access_token: data.access_token, account_id: data.account_id } : null);
  const apiKey = data.api_key || data.OPENAI_API_KEY;
  if (tokens) {
    return { type: 'codex', accessToken: tokens.access_token, accountId: tokens.account_id };
  }
  if (apiKey) {
    return { type: 'api_key', apiKey };
  }
  throw new Error('auth.json 中未找到 access_token+account_id 或 api_key/OPENAI_API_KEY');
}

/**
 * 从已解析的 auth 对象（如 auth.json 内容）提取 Codex 认证，供账号列表使用
 */
export function parseAuthFromJson(data) {
  const tokens = data.tokens || (data.access_token ? { access_token: data.access_token, account_id: data.account_id } : null);
  const apiKey = data.api_key || data.OPENAI_API_KEY;
  if (tokens) {
    return { type: 'codex', accessToken: tokens.access_token, accountId: tokens.account_id };
  }
  if (apiKey) {
    return { type: 'api_key', apiKey };
  }
  throw new Error('未找到 access_token+account_id 或 api_key');
}

/**
 * 创建轮询 getter：每次调用返回下一个账号
 */
export function createRoundRobinProvider(auths) {
  let index = 0;
  return () => auths[index++ % auths.length];
}

export { resolveAuthPath, DEFAULT_AUTH_PATH };
