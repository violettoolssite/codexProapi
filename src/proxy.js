import { randomUUID } from 'crypto';
import { loadAuth } from './auth.js';
import { markAccountUnavailable } from './accountStatus.js';
import { recordUsage, clearUsage } from './usageTracker.js';

const BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';

const BROWSER_HEADERS = {
  'Accept': 'text/event-stream',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://chatgpt.com/',
  'Origin': 'https://chatgpt.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'DNT': '1',
  'OpenAI-Beta': 'responses=experimental',
  'originator': 'codex_cli_rs',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function getMessageContentParts(msg) {
  const content = [];
  const raw = msg.content;
  if (typeof raw === 'string') {
    if (raw.trim()) content.push({ type: 'text', text: raw });
  } else if (Array.isArray(raw)) {
    for (const c of raw) {
      if (c == null) continue;
      if (typeof c === 'string') {
        if (c.trim()) content.push({ type: 'text', text: c });
        continue;
      }
      if (typeof c !== 'object') continue;
      if (c.type === 'image_url' || c.image_url) {
        const url = typeof c.image_url === 'string' ? c.image_url : (c.image_url?.url || '');
        const detail = c.image_url?.detail || 'auto';
        if (url) content.push({ type: 'image_url', url, detail });
      } else if (c.type === 'text' || c.text != null) {
        const text = String(c.text ?? '').trim();
        if (text) content.push({ type: 'text', text });
      }
    }
  } else {
    const text = String(raw ?? '').trim();
    if (text) content.push({ type: 'text', text });
  }
  return content;
}

function messagesToInput(messages) {
  const parts = [];
  let hasImage = false;
  const textLines = [];

  for (const msg of messages) {
    const role = String(msg.role || 'user').toLowerCase();
    const contentParts = getMessageContentParts(msg);
    if (contentParts.length === 0) continue;

    const texts = contentParts.filter((p) => p.type === 'text').map((p) => p.text);
    const images = contentParts.filter((p) => p.type === 'image_url');

    if (role === 'assistant') {
      textLines.push(`Assistant: ${texts.join(' ')}`);
      continue;
    }
    if (role === 'system') {
      textLines.push(`System: ${texts.join(' ')}`);
      continue;
    }
    // user
    if (textLines.length) textLines.push('');
    textLines.push(`User: ${texts.join(' ')}`);
    for (const img of images) {
      hasImage = true;
      parts.push({ type: 'input_image', image_url: img.url, detail: img.detail || 'auto' });
    }
  }

  const fullText = textLines.join('\n').trim();
  if (fullText) parts.unshift({ type: 'input_text', text: fullText });
  if (parts.length === 0) return [];
  return [{ type: 'message', role: 'user', content: parts }];
}

/** 官方标准：约 4 字符 = 1 token，用于估算 prompt_tokens */
function estimatePromptTokens(openaiReq) {
  let chars = 0;
  const messages = openaiReq.messages || [];
  for (const msg of messages) {
    const parts = getMessageContentParts(msg);
    for (const p of parts) {
      if (p.type === 'text' && p.text) chars += String(p.text).length;
    }
  }
  const tools = openaiReq.tools;
  if (Array.isArray(tools)) {
    chars += JSON.stringify(tools).length;
  }
  return Math.max(0, Math.ceil(chars / 4));
}

/**
 * 构建发往 ChatGPT Codex 后端的请求体
 * 后端强制要求 stream 为 true，故始终传 true；是否向客户端流式由 handleChatCompletions 根据 openaiReq.stream 决定。
 */
function buildResponsesRequest(openaiReq) {
  return {
    model: openaiReq.model || 'gpt-5.3-codex',
    instructions: 'You are a helpful AI assistant. Provide clear, accurate, and concise responses.',
    input: messagesToInput(openaiReq.messages || []),
    tools: openaiReq.tools || [],
    tool_choice: openaiReq.tool_choice ?? 'auto',
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    stream: true,
    include: [],
  };
}

/**
 * 非流式：从 SSE 响应中收集完整文本后返回
 */
async function parseStreamToText(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let fullText = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          const type = event.type;
          // 只从 delta 收集，避免与 output_item.done 重复
          if (type === 'response.output_text.delta' && event.delta) {
            fullText += event.delta;
          }
        } catch (_) {}
      }
    }
  }
  return fullText;
}

/**
 * 流式：将后端 SSE 转为 OpenAI Chat Completions SSE 格式并写入 res
 * @param {object} [opts] - { onFinish(completionChars) } 流结束时回调，用于用量统计
 */
function pipeStreamToOpenAI(backendStream, res, model, id, opts = {}) {
  const dec = new TextDecoder();
  let buffer = '';
  let hasSentRole = false;
  let completionChars = 0;
  const onFinish = opts.onFinish || (() => {});
  const sendChunk = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const sendDelta = (delta, finishReason = null) => {
    const choice = { index: 0, delta, finish_reason: finishReason };
    sendChunk({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [choice],
    });
  };
  const reader = backendStream.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            onFinish(completionChars);
            sendDelta({}, 'stop');
            res.write('data: [DONE]\n\n');
            return;
          }
          try {
            const event = JSON.parse(data);
            const type = event.type;
            if (type === 'response.output_text.delta' && event.delta) {
              completionChars += String(event.delta).length;
              if (!hasSentRole) {
                sendDelta({ role: 'assistant' });
                hasSentRole = true;
              }
              sendDelta({ content: event.delta });
            }
          } catch (_) {}
        }
      }
      onFinish(completionChars);
      if (!hasSentRole) sendDelta({ role: 'assistant' });
      sendDelta({}, 'stop');
      res.write('data: [DONE]\n\n');
    } catch (e) {
      onFinish(completionChars);
      sendDelta({ content: `\n[Error: ${e.message}]` }, 'stop');
      res.write('data: [DONE]\n\n');
    } finally {
      res.end();
    }
  })();
}

/**
 * 调用 Codex 后端（仅支持 Codex token，不支持纯 api_key 调此接口）
 */
/**
 * 解析认证：authProvider 可为路径字符串、auth 对象、或 () => auth 的 getter
 */
function resolveAuth(authProvider) {
  if (typeof authProvider === 'function') return authProvider();
  if (authProvider && typeof authProvider === 'object' && authProvider.accessToken) return authProvider;
  return loadAuth(authProvider);
}

export async function callCodexBackend(openaiReq, authProvider = null) {
  const auth = resolveAuth(authProvider);
  if (auth.type !== 'codex') {
    throw new Error('ChatGPT/Codex 反代需要 access_token + account_id，请使用 Codex 登录后的 auth.json');
  }
  const body = buildResponsesRequest(openaiReq);
  const sessionId = randomUUID();
  const headers = {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth.accessToken}`,
    'chatgpt-account-id': auth.accountId,
    'session_id': sessionId,
  };
  const res = await fetch(BACKEND_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const status = res.status;
    if (status === 401 || status === 403) {
      markAccountUnavailable(auth.accountId);
      clearUsage(auth.accountId);
    }
    const text = await res.text();
    throw new Error(`Codex 后端错误 ${status}: ${text.slice(0, 500)}`);
  }
  return { response: res, model: body.model, stream: body.stream, auth };
}

/**
 * 处理一次 Chat Completions 请求：流式或非流式，支持多账号故障切换（失败时自动尝试下一账号）
 * @param {object} openaiReq - 请求体
 * @param {object} res - Express res
 * @param {Function} authProvider - () => auth 或轮询 getter，失败时可多次调用取下一账号
 * @param {number} accountCount - 账号数量，用于故障切换最大重试次数
 * @returns {Promise<object|null>} 成功时返回本次使用的 auth，失败返回 null
 */
export async function handleChatCompletions(openaiReq, res, authProvider = null, accountCount = 1) {
  const stream = openaiReq.stream === true;
  const model = openaiReq.model || 'gpt-5.3-codex';
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  const maxTries = Math.max(1, Number(accountCount) || 1);
  let lastError = null;

  for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
    try {
      const auth = typeof authProvider === 'function' ? authProvider() : null;
      const provider = auth ? () => auth : authProvider;
      const { response: backendRes, model: backendModel, auth: usedAuth } = await callCodexBackend(openaiReq, provider);
      const who = usedAuth || auth;
      const promptTokens = estimatePromptTokens(openaiReq);
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        pipeStreamToOpenAI(backendRes.body, res, backendModel, id, {
          onFinish: (completionChars) => {
            if (who?.accountId) {
              recordUsage(who.accountId, {
                prompt_tokens: promptTokens,
                completion_tokens: Math.ceil(completionChars / 4),
              });
            }
          },
        });
        return who ?? null;
      }
      const text = await parseStreamToText(backendRes.body);
      const completionTokens = Math.ceil(text.length / 4);
      if (who?.accountId) {
        recordUsage(who.accountId, { prompt_tokens: promptTokens, completion_tokens: completionTokens });
      }
      res.json({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: backendModel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
      return who ?? null;
    } catch (e) {
      lastError = e;
      if (res.headersSent) throw e;
      const status = e.message && /^\D*(\d{3})/.exec(e.message);
      const code = status ? Number(status[1]) : 0;
      const isRetryable = code >= 400 && code < 600;
      if (!isRetryable || tryIndex >= maxTries - 1) break;
    }
  }

  if (!res.headersSent) {
    let msg = lastError?.message ?? 'Proxy error';
    if (msg === 'fetch failed' || /^fetch failed/i.test(msg)) {
      msg = 'fetch failed: 无法连接 Codex 后端 (chatgpt.com)。请检查网络/VPN，并确认已添加至少一个 Codex 账号。详见配置页或 README。';
    }
    res.status(500).json({
      error: {
        message: msg,
        type: 'proxy_error',
        code: 'internal_error',
      },
    });
  }
  return null;
}
