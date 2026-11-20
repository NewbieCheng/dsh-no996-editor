/**
 * First-class DSH LLM adapter for 不加班 (`no996`) workbench gateway (`/v1/responses`).
 *
 * - Advertises `no996/auto` first with `inputModalities: ['text', 'image']` so DSH sends
 *   attached images inline to `/v1/responses` (where backend Auto Vision routing selects a
 *   vision-capable route while keeping external model identity `auto`).
 * - Uses Host-only short-lived JWT (`auth.accessToken()` with single-flight `refresh()` retry on
 *   HTTP 401) against `/v1/responses`. No static API Key is ever stored on client disk.
 * - Attaches DSH `attributionHeaders()` to every outbound HTTP request.
 */

let dshLlmModPromise;
async function loadDshLlm() {
  if (!dshLlmModPromise) {
    dshLlmModPromise = import('@deepseek-ai/dsh-llm').catch(() => null);
  }
  return dshLlmModPromise;
}

function defaultAttributionHeaders() {
  return { 'user-agent': 'deepseek-harness/0.2.0 (https://github.com/deepseek-ai/deepseek-harness)' };
}

function makeLlmError(message, code = 'PROVIDER', extra = {}) {
  const err = new Error(message);
  err.name = 'LlmError';
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function textFromBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');
}

function fallbackOffloadedImageText(ref) {
  const name = ref?.filename || ref?.attachmentId || 'image';
  return `[Image omitted: ${name}]`;
}

function parseRetryAfterMs(headerVal) {
  if (!headerVal) return undefined;
  const secs = Number(headerVal);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const dateMs = Date.parse(headerVal);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

const DEFAULT_EFFORTS = Object.freeze([
  { id: 'low', name: '低', description: '快速响应，较少推理步骤' },
  { id: 'medium', name: '中', description: '均衡推理深度与速度' },
  { id: 'high', name: '高', description: '深度思考，适合复杂剪辑与规划' },
]);

/**
 * Serialize DSH RequestMessage[] + Tools into OpenAI Responses API payload.
 */
async function serializeResponsesRequest(options, { resolveAttachments, resolveImageAccess, dshLlm, signal }) {
  const instructionsParts = [];
  if (typeof options.system === 'string' && options.system.trim()) {
    instructionsParts.push(options.system.trim());
  }

  const input = [];
  const attachments = resolveAttachments?.();
  const messages = Array.isArray(options.messages) ? options.messages : [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      const txt = textFromBlocks(msg.content);
      if (txt.trim()) instructionsParts.push(txt.trim());
      continue;
    }

    if (msg.role === 'user') {
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
      const content = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          content.push({ type: 'input_text', text: block.text });
        } else if (block.type === 'file' && block.attachment) {
          const fname = block.attachment.filename || block.attachment.attachmentId || 'file';
          content.push({ type: 'input_text', text: `[Attached file: ${fname}]` });
        } else if (block.type === 'image' && block.attachment) {
          if (block.offloaded || !attachments || typeof attachments.readImageRequest !== 'function') {
            const accessPath = typeof resolveImageAccess === 'function' ? resolveImageAccess(attachments, block.attachment) : undefined;
            const hint = typeof dshLlm?.offloadedImageText === 'function'
              ? dshLlm.offloadedImageText(block.attachment, accessPath)
              : fallbackOffloadedImageText(block.attachment);
            content.push({ type: 'input_text', text: hint });
          } else {
            try {
              const target = {
                width: block.attachment.width || 2048,
                height: block.attachment.height || 2048,
                maxBytes: block.attachment.bytes || 4 * 1024 * 1024,
              };
              const imgData = await attachments.readImageRequest(block.attachment, target, signal);
              const b64 = Buffer.from(imgData.bytes).toString('base64');
              const mime = imgData.mediaType || block.attachment.mediaType || 'image/png';
              content.push({ type: 'input_image', image_url: `data:${mime};base64,${b64}` });
            } catch {
              content.push({ type: 'input_text', text: fallbackOffloadedImageText(block.attachment) });
            }
          }
        }
      }
      if (content.length > 0) input.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const textParts = [];
      const toolCalls = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          textParts.push({ type: 'output_text', text: block.text });
        } else if (block.type === 'tool-call' && block.id && block.name) {
          toolCalls.push({
            type: 'function_call',
            call_id: String(block.id),
            name: String(block.name),
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {}),
          });
        }
      }
      if (textParts.length > 0) input.push({ type: 'message', role: 'assistant', content: textParts });
      for (const tc of toolCalls) input.push(tc);
      continue;
    }

    if (msg.role === 'tool') {
      const callId = msg.source?.callId || msg.toolCallId || '';
      if (!callId) continue;
      const outText = textFromBlocks(msg.content) || '[ok]';
      input.push({
        type: 'function_call_output',
        call_id: String(callId),
        output: outText,
      });
    }
  }

  const tools = Array.isArray(options.tools) && options.tools.length > 0
    ? options.tools.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      }))
    : undefined;

  const body = {
    model: options.model || 'auto',
    stream: true,
    ...(instructionsParts.length > 0 ? { instructions: instructionsParts.join('\n\n') } : {}),
    input: input.length > 0 ? input : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }],
    ...(tools ? { tools } : {}),
    ...(options.reasoningEffort ? { reasoning: { effort: String(options.reasoningEffort) } } : {}),
    ...(Number.isFinite(options.maxTokens) ? { max_output_tokens: options.maxTokens } : {}),
    ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
  };
  return body;
}

/**
 * Parse an SSE ReadableStream into `{ event, data }` pairs.
 */
async function* readSseFrames(bodyStream, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of bodyStream) {
    if (signal?.aborted) break;
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    while (true) {
      const sepIdx = buffer.search(/\r?\n\r?\n/);
      if (sepIdx === -1) break;
      const rawFrame = buffer.slice(0, sepIdx);
      const match = buffer.slice(sepIdx).match(/^\r?\n\r?\n/);
      buffer = buffer.slice(sepIdx + (match ? match[0].length : 2));
      let eventName = 'message';
      const dataLines = [];
      for (const line of rawFrame.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return;
      try {
        yield { event: eventName, data: JSON.parse(payload) };
      } catch {
        // Ignore malformed non-JSON heartbeat payloads
      }
    }
  }
}

export function createNo996LlmAdapter({
  auth,
  fetchImpl = globalThis.fetch,
  resolveAttachments = () => undefined,
  resolveImageAccess = undefined,
  onWalletDirty = undefined,
} = {}) {
  const base = String(auth?.baseUrl || '').replace(/\/+$/, '');
  const modelMetaCache = new Map();

  async function resolveBearer({ forceRefresh = false } = {}) {
    if (!auth) throw makeLlmError('不加班认证服务未就绪', 'INVALID_CREDENTIAL');
    if (auth.dev || auth.guest) {
      throw makeLlmError('游客或开发模式不支持调用平台付费模型，请登录正式不加班账号', 'INVALID_CREDENTIAL');
    }
    const jwt = forceRefresh && typeof auth.refreshTokenSession === 'function'
      ? await auth.refreshTokenSession()
      : await auth.accessToken?.();
    if (!jwt) throw makeLlmError('请先登录不加班账号后再使用平台模型', 'INVALID_CREDENTIAL');
    return jwt;
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: '不加班' };
    },
    providerRetryPolicy() {
      return undefined;
    },
    imageRequestPricing() {
      return undefined;
    },
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes };
    },
    async listModels(provider) {
      const signedOutAutoModel = {
        provider,
        id: 'auto',
        name: '不加班 Auto (需先登录)',
        description: '请先在「视频创作」或插件设置中登录不加班账号；登录后自动启用智能路由与识图',
        inputModalities: ['text', 'image'],
      };
      const autoModel = {
        provider,
        id: 'auto',
        name: '不加班 Auto (智能路由 · 支持识图)',
        description: '按平台路由自动选择最优模型，支持文本与图片理解，统一积分计费',
        inputModalities: ['text', 'image'],
      };
      modelMetaCache.clear();
      if (!auth || auth.dev || auth.guest) {
        modelMetaCache.set('auto', signedOutAutoModel);
        return [signedOutAutoModel];
      }
      const status = await auth.status?.().catch(() => null);
      if (!status?.loggedIn || status?.guest || status?.dev) {
        modelMetaCache.set('auto', signedOutAutoModel);
        return [signedOutAutoModel];
      }
      modelMetaCache.set('auto', autoModel);

      try {
        const dshLlm = await loadDshLlm();
        const attr = typeof dshLlm?.attributionHeaders === 'function' ? dshLlm.attributionHeaders() : defaultAttributionHeaders();
        let bearer = await resolveBearer().catch(() => null);
        if (!bearer) return [autoModel];
        let res = await fetchImpl(`${base}/v1/models`, {
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${bearer}`, ...attr },
          signal: AbortSignal.timeout(8000),
        });
        if (res.status === 401 && typeof auth?.refreshTokenSession === 'function') {
          const refreshed = await auth.refreshTokenSession().catch(() => null);
          if (refreshed) {
            bearer = refreshed;
            res = await fetchImpl(`${base}/v1/models`, {
              method: 'GET',
              headers: { accept: 'application/json', authorization: `Bearer ${bearer}`, ...attr },
              signal: AbortSignal.timeout(8000),
            });
          }
        }
        if (!res.ok) return [autoModel];
        const json = await res.json();
        const rows = Array.isArray(json?.data) ? json.data : [];
        const extras = rows
          .filter(r => r && typeof r.id === 'string' && r.id && r.id !== 'auto')
          .map(r => {
            const displayName = (typeof r.display_name === 'string' && r.display_name)
              || (typeof r.name === 'string' && r.name)
              || r.id;
            const rawMods = Array.isArray(r.input_modalities) ? r.input_modalities
              : (Array.isArray(r.modalities) ? r.modalities : null);
            const inputModalities = rawMods && rawMods.length ? rawMods : ['text'];
            const contextWindow = Number.isFinite(Number(r.context_window)) && Number(r.context_window) > 0
              ? Number(r.context_window)
              : 128000;
            const entry = {
              provider,
              id: r.id,
              name: displayName,
              inputModalities,
              contextWindow,
            };
            modelMetaCache.set(r.id, entry);
            return {
              provider,
              id: entry.id,
              name: entry.name,
              inputModalities: entry.inputModalities,
            };
          });
        return [autoModel, ...extras];
      } catch {
        return [autoModel];
      }
    },
    async resolveModel(provider, model) {
      const cached = modelMetaCache.get(model);
      return {
        provider,
        id: model,
        name: cached?.name || (model === 'auto' ? '不加班 Auto (智能路由 · 支持识图)' : model),
        context: { contextWindow: cached?.contextWindow || 128000 },
        inputModalities: cached?.inputModalities || (model === 'auto' ? ['text', 'image'] : ['text']),
        reasoning: { efforts: [...DEFAULT_EFFORTS], defaultEffort: 'medium' },
      };
    },
    async prepareCall(provider, model, signal) {
      const resolved = await this.resolveModel(provider, model, signal);
      return {
        model: resolved,
        stream: options => this.stream(options),
      };
    },
    async * stream(options) {
      const dshLlm = await loadDshLlm();
      const attr = typeof dshLlm?.attributionHeaders === 'function' ? dshLlm.attributionHeaders() : defaultAttributionHeaders();
      let bearer = await resolveBearer();
      const payload = await serializeResponsesRequest(options, {
        resolveAttachments,
        resolveImageAccess,
        dshLlm,
        signal: options.signal,
      });

      const doFetch = (token) => fetchImpl(`${base}/v1/responses`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...attr,
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      });

      let response = await doFetch(bearer);
      if (response.status === 401 && typeof auth?.refreshTokenSession === 'function') {
        const refreshed = await auth.refreshTokenSession().catch(() => null);
        if (refreshed) {
          bearer = refreshed;
          response = await doFetch(bearer);
        }
      }

      if (!response.ok) {
        const rawErr = await response.text().catch(() => '');
        let errJson = {};
        try { errJson = JSON.parse(rawErr || '{}'); } catch { /* ignore */ }
        const message = String(errJson?.error?.message || errJson?.message || `不加班网关返回 HTTP ${response.status}`);
        const code = response.status === 401
          ? 'INVALID_CREDENTIAL'
          : response.status === 429
            ? 'RATE_LIMIT'
            : response.status === 402
              ? 'INSUFFICIENT_BALANCE'
              : String(errJson?.error?.code || `HTTP_${response.status}`);
        throw makeLlmError(message, code, {
          status: response.status,
          requestId: response.headers?.get?.('x-request-id') || undefined,
          providerRetryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after')),
        });
      }

      if (!response.body) {
        throw makeLlmError('不加班网关返回了空的响应流', 'TRANSPORT');
      }

      let nextBlockIndex = 0;
      let textBlock = null; // { index, text }
      let reasoningBlock = null; // { index, text }
      const toolBlocks = new Map(); // output_index/call_id -> { index, id, name, args, closed }
      let hasToolCalls = false;
      let usage = null;
      let finishReason = { kind: 'stop' };

      const closeText = function* () {
        if (textBlock) {
          yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } };
          textBlock = null;
        }
      };
      const closeReasoning = function* () {
        if (reasoningBlock) {
          yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } };
          reasoningBlock = null;
        }
      };

      for await (const frame of readSseFrames(response.body, options.signal)) {
        const type = frame.data?.type || frame.event;
        const data = frame.data || {};

        if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (!delta) continue;
          yield* closeText();
          if (!reasoningBlock) {
            reasoningBlock = { index: nextBlockIndex++, text: '' };
            yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
          }
          reasoningBlock.text += delta;
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta };
          continue;
        }

        if (type === 'response.output_text.delta') {
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (!delta) continue;
          yield* closeReasoning();
          if (!textBlock) {
            textBlock = { index: nextBlockIndex++, text: '' };
            yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
          }
          textBlock.text += delta;
          yield { type: 'text-delta', index: textBlock.index, text: delta };
          continue;
        }

        if (type === 'response.output_item.added' && data.item?.type === 'function_call') {
          yield* closeReasoning();
          yield* closeText();
          const key = data.output_index ?? data.item.call_id ?? data.item.id ?? nextBlockIndex;
          const callId = String(data.item.call_id || data.item.id || `call_${nextBlockIndex}`);
          const name = String(data.item.name || '');
          const tb = { index: nextBlockIndex++, id: callId, name, args: String(data.item.arguments || ''), closed: false };
          toolBlocks.set(key, tb);
          hasToolCalls = true;
          yield { type: 'block-start', index: tb.index, blockType: 'tool-call' };
          if (tb.args) {
            yield { type: 'tool-call-delta', index: tb.index, id: tb.id, name: tb.name, argumentsDelta: tb.args };
          }
          continue;
        }

        if (type === 'response.function_call_arguments.delta') {
          const key = data.output_index ?? data.call_id ?? data.item_id;
          let tb = toolBlocks.get(key);
          if (!tb) {
            yield* closeReasoning();
            yield* closeText();
            const callId = String(data.call_id || data.item_id || `call_${nextBlockIndex}`);
            tb = { index: nextBlockIndex++, id: callId, name: String(data.name || ''), args: '', closed: false };
            toolBlocks.set(key, tb);
            hasToolCalls = true;
            yield { type: 'block-start', index: tb.index, blockType: 'tool-call' };
          }
          const delta = typeof data.delta === 'string' ? data.delta : '';
          if (delta) {
            tb.args += delta;
            yield { type: 'tool-call-delta', index: tb.index, id: tb.id, name: tb.name || undefined, argumentsDelta: delta };
          }
          continue;
        }

        if (type === 'response.output_item.done' && data.item?.type === 'function_call') {
          const key = data.output_index ?? data.item.call_id ?? data.item.id;
          const tb = toolBlocks.get(key);
          if (tb && !tb.closed) {
            tb.name = tb.name || String(data.item.name || '');
            tb.args = typeof data.item.arguments === 'string' && data.item.arguments ? data.item.arguments : tb.args;
            tb.closed = true;
            yield {
              type: 'block-end',
              index: tb.index,
              block: { type: 'tool-call', id: tb.id, name: tb.name, arguments: tb.args || '{}' },
            };
          }
          continue;
        }

        if (type === 'response.completed' || type === 'response.done') {
          const resp = data.response || data;
          const u = resp?.usage;
          if (u && typeof u === 'object') {
            const cached = Number(u.input_tokens_details?.cached_tokens ?? 0);
            const rawIn = Number(u.input_tokens ?? 0);
            const out = Number(u.output_tokens ?? 0);
            const reasonTok = u.output_tokens_details?.reasoning_tokens;
            usage = {
              inputTokens: Math.max(0, rawIn - (Number.isFinite(cached) ? cached : 0)),
              outputTokens: Math.max(0, out),
              ...(Number.isFinite(u.total_tokens) ? { totalTokens: u.total_tokens } : {}),
              ...(cached > 0 ? { cacheReadTokens: cached } : {}),
              ...(Number.isFinite(reasonTok) && reasonTok > 0 ? { reasoningTokens: reasonTok } : {}),
            };
          }
          if (hasToolCalls) finishReason = { kind: 'tool-calls' };
          else if (resp?.status === 'incomplete') finishReason = { kind: 'max-tokens' };
          else finishReason = { kind: 'stop' };
          continue;
        }

        if (type === 'response.failed' || type === 'error') {
          const err = data.error || data.response?.error || {};
          finishReason = {
            kind: 'error',
            failure: {
              message: String(err.message || '不加班网关请求失败'),
              code: String(err.code || 'PROVIDER_ERROR'),
            },
          };
        }
      }

      yield* closeReasoning();
      yield* closeText();
      for (const tb of toolBlocks.values()) {
        if (!tb.closed) {
          tb.closed = true;
          yield {
            type: 'block-end',
            index: tb.index,
            block: { type: 'tool-call', id: tb.id, name: tb.name, arguments: tb.args || '{}' },
          };
        }
      }

      if (usage) {
        yield { type: 'usage', usage };
      }
      onWalletDirty?.('llm');
      yield { type: 'finish', reason: finishReason };
    },
  };
}

/** Register `no996` adapter on DSH `ctx.llm` if present. */
export function registerNo996LlmProvider(ctx, { auth, resolveAttachments, resolveImageAccess, onWalletDirty, fetchImpl } = {}) {
  if (!ctx?.llm || typeof ctx.llm.registerAdapter !== 'function') {
    return { dispose: () => {}, refresh: () => {} };
  }
  const adapter = createNo996LlmAdapter({ auth, resolveAttachments, resolveImageAccess, onWalletDirty, fetchImpl });
  const handle = ctx.llm.registerAdapter(['no996'], adapter);
  return {
    dispose: () => {
      try { handle(); } catch { /* already disposed */ }
    },
    refresh: () => {
      try {
        if (typeof handle?.replace === 'function') {
          handle.replace(['no996']);
        }
      } catch { /* already disposed */ }
    },
  };
}
