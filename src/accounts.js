import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseAuthFromJson } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ACCOUNTS_FILE = join(__dirname, '..', 'data', 'accounts.json');

function getAccountsPath() {
  return process.env.CODEX_ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE;
}

/**
 * 读取账号列表（不包含 token 明文，用于 API 展示）
 */
export function listAccountsForApi() {
  const path = getAccountsPath();
  if (!existsSync(path)) return { accounts: [] };
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  return {
    accounts: list.map((item, index) => {
      const accountId = item.account_id || item.tokens?.account_id || '';
      return {
        index,
        name: item.name || `账号 ${index + 1}`,
        accountIdMask: accountId ? `${accountId.slice(0, 8)}…` : '—',
        source: item.source || 'manual',
      };
    }),
  };
}

/**
 * 读取完整账号列表（含 token），供代理轮询使用
 */
export function loadAccountsForProxy() {
  const path = getAccountsPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const auths = [];
  for (const item of list) {
    const tokens = item.tokens || (item.access_token ? { access_token: item.access_token, account_id: item.account_id } : null);
    if (tokens?.access_token && tokens?.account_id) {
      auths.push({
        type: 'codex',
        accessToken: tokens.access_token,
        accountId: tokens.account_id,
        name: item.name || null,
      });
    }
  }
  return auths;
}

/**
 * 添加一个账号并写入文件
 * body: { name?, access_token, account_id } 或 { name?, authJson: "..." }
 */
export function addAccount(body) {
  const path = getAccountsPath();
  let entry;
  if (body.authJson) {
    const data = JSON.parse(body.authJson);
    const auth = parseAuthFromJson(data);
    if (auth.type !== 'codex') throw new Error('仅支持 Codex 账号（access_token + account_id）');
    entry = {
      name: body.name || null,
      access_token: auth.accessToken,
      account_id: auth.accountId,
      source: body.source || 'manual',
    };
  } else if (body.access_token && body.account_id) {
    entry = {
      name: body.name || null,
      access_token: body.access_token,
      account_id: body.account_id,
      source: body.source || 'manual',
    };
  } else {
    throw new Error('请提供 authJson（粘贴 auth.json 内容）或 access_token + account_id');
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let list = [];
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    list = Array.isArray(data) ? data : (data.accounts || []);
  }
  list.push(entry);
  writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  return { ok: true };
}

/**
 * 按索引删除账号
 */
export function deleteAccount(index) {
  const path = getAccountsPath();
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const i = Number(index);
  if (i >= 0 && i < list.length) {
    list.splice(i, 1);
    writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  }
}

export { getAccountsPath };
