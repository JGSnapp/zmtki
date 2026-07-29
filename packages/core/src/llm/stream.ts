import {
  buildAnthropicPayload,
  buildGooglePayload,
  buildOllamaPayload,
  buildOpenAiPayload,
  sanitizeMessages
} from './payloads.js';
import { buildChatUrl, buildHeaders } from './providers.js';
import { buildResponsesPayload, newSessionId, parseResponsesEvent, responsesHeaders } from './responses.js';
import {
  LlmError,
  type CompletionRequest,
  type ResolvedEndpoint,
  type StreamEvent,
  type ToolCall,
  type Usage
} from './types.js';

const EMPTY_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };

/** Iterates `data:` lines of a Server-Sent Events body. */
async function* sseLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
        index = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/** Ollama streams newline-delimited JSON rather than SSE. */
async function* ndjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) yield line;
        index = buffer.indexOf('\n');
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function postStream(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  signal?: AbortSignal
): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(
      `${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
      response.status,
      isRetryableStatus(response.status)
    );
  }
  if (!response.body) throw new LlmError('пустой ответ от провайдера', 502, true);
  return response;
}

/** Accumulates OpenAI's index-keyed tool call deltas into whole calls. */
class ToolCallAccumulator {
  private byIndex = new Map<number, { id: string; name: string; args: string }>();

  push(index: number, id: string | undefined, name: string | undefined, argsDelta: string | undefined): void {
    const existing = this.byIndex.get(index) ?? { id: '', name: '', args: '' };
    if (id) existing.id = id;
    if (name) existing.name = name;
    if (argsDelta) existing.args += argsDelta;
    this.byIndex.set(index, existing);
  }

  drain(): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const [index, value] of [...this.byIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (!value.name) continue;
      calls.push({
        id: value.id || `call_${index}_${Date.now()}`,
        name: value.name,
        arguments: value.args || '{}'
      });
    }
    this.byIndex.clear();
    return calls;
  }

  get size(): number {
    return this.byIndex.size;
  }
}

async function* streamOpenAiCompatible(
  endpoint: ResolvedEndpoint,
  req: CompletionRequest
): AsyncGenerator<StreamEvent> {
  const url = buildChatUrl(endpoint.baseUrl, endpoint.provider, req.model);
  const headers = buildHeaders(endpoint.provider, endpoint.apiKey);
  const response = await postStream(url, headers, buildOpenAiPayload(req, true), req.signal);

  const tools = new ToolCallAccumulator();
  let usage: Usage = { ...EMPTY_USAGE };

  for await (const data of sseLines(response.body!, req.signal)) {
    if (data === '[DONE]') break;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const rawUsage = parsed.usage as Record<string, number> | undefined;
    if (rawUsage) {
      usage = {
        promptTokens: rawUsage.prompt_tokens ?? 0,
        completionTokens: rawUsage.completion_tokens ?? 0,
        totalTokens: rawUsage.total_tokens ?? 0,
        cachedTokens:
          (parsed.usage as { prompt_tokens_details?: { cached_tokens?: number } })
            ?.prompt_tokens_details?.cached_tokens ?? 0
      };
    }

    const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning };

    if (typeof delta.content === 'string' && delta.content) {
      yield { type: 'text', text: delta.content };
    }

    const deltaCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (deltaCalls) {
      for (const call of deltaCalls) {
        const fn = call.function as { name?: string; arguments?: string } | undefined;
        tools.push(
          typeof call.index === 'number' ? call.index : 0,
          call.id as string | undefined,
          fn?.name,
          fn?.arguments
        );
      }
    }
  }

  if (tools.size > 0) yield { type: 'toolCalls', calls: tools.drain() };
  yield { type: 'usage', usage };
}

async function* streamAnthropic(
  endpoint: ResolvedEndpoint,
  req: CompletionRequest
): AsyncGenerator<StreamEvent> {
  const url = buildChatUrl(endpoint.baseUrl, 'anthropic', req.model);
  const headers = buildHeaders('anthropic', endpoint.apiKey);
  const response = await postStream(url, headers, buildAnthropicPayload(req, true), req.signal);

  const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
  const calls: ToolCall[] = [];
  // Anthropic reports input and output token counts in separate events, so the
  // object is filled in place as they arrive rather than replaced.
  const usage: Usage = { ...EMPTY_USAGE };

  for await (const data of sseLines(response.body!, req.signal)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    switch (event.type) {
      case 'message_start': {
        const u = (event.message as { usage?: Record<string, number> } | undefined)?.usage;
        if (u) {
          usage.promptTokens = u.input_tokens ?? 0;
          usage.cachedTokens = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
        break;
      }
      case 'content_block_start': {
        const index = event.index as number;
        const block = event.content_block as { type: string; id?: string; name?: string };
        blocks.set(index, { type: block.type, id: block.id ?? '', name: block.name ?? '', json: '' });
        break;
      }
      case 'content_block_delta': {
        const index = event.index as number;
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text', text: delta.text };
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'reasoning', text: delta.thinking };
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const block = blocks.get(index);
          if (block) block.json += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const block = blocks.get(event.index as number);
        if (block?.type === 'tool_use') {
          calls.push({ id: block.id, name: block.name, arguments: block.json || '{}' });
        }
        break;
      }
      case 'message_delta': {
        const u = event.usage as Record<string, number> | undefined;
        if (u) usage.completionTokens = u.output_tokens ?? usage.completionTokens;
        break;
      }
      default:
        break;
    }
  }

  usage.totalTokens = usage.promptTokens + usage.completionTokens;
  if (calls.length > 0) yield { type: 'toolCalls', calls };
  yield { type: 'usage', usage };
}

async function* streamOllama(
  endpoint: ResolvedEndpoint,
  req: CompletionRequest
): AsyncGenerator<StreamEvent> {
  const url = buildChatUrl(endpoint.baseUrl, 'ollama', req.model);
  const headers = buildHeaders('ollama', endpoint.apiKey);
  const response = await postStream(url, headers, buildOllamaPayload(req, true), req.signal);

  const calls: ToolCall[] = [];
  let usage: Usage = { ...EMPTY_USAGE };
  let counter = 0;

  for await (const line of ndjson(response.body!, req.signal)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const message = event.message as Record<string, unknown> | undefined;
    if (message) {
      if (typeof message.thinking === 'string' && message.thinking) {
        yield { type: 'reasoning', text: message.thinking };
      }
      if (typeof message.content === 'string' && message.content) {
        yield { type: 'text', text: message.content };
      }
      const toolCalls = message.tool_calls as Array<{ function?: { name?: string; arguments?: unknown } }> | undefined;
      for (const call of toolCalls ?? []) {
        if (!call.function?.name) continue;
        calls.push({
          id: `call_${counter++}`,
          name: call.function.name,
          arguments: JSON.stringify(call.function.arguments ?? {})
        });
      }
    }

    if (event.done === true) {
      usage = {
        promptTokens: (event.prompt_eval_count as number) ?? 0,
        completionTokens: (event.eval_count as number) ?? 0,
        totalTokens: ((event.prompt_eval_count as number) ?? 0) + ((event.eval_count as number) ?? 0),
        cachedTokens: 0
      };
    }
  }

  if (calls.length > 0) yield { type: 'toolCalls', calls };
  yield { type: 'usage', usage };
}

async function* streamGoogle(
  endpoint: ResolvedEndpoint,
  req: CompletionRequest
): AsyncGenerator<StreamEvent> {
  const url = buildChatUrl(endpoint.baseUrl, 'google', req.model);
  const headers = buildHeaders('google', endpoint.apiKey);
  const response = await postStream(url, headers, buildGooglePayload(req), req.signal);

  const calls: ToolCall[] = [];
  let usage: Usage = { ...EMPTY_USAGE };
  let counter = 0;

  for await (const data of sseLines(response.body!, req.signal)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const candidate = (event.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const parts = (candidate?.content as { parts?: Array<Record<string, unknown>> } | undefined)?.parts;
    for (const part of parts ?? []) {
      if (typeof part.text === 'string' && part.text) {
        if (part.thought === true) yield { type: 'reasoning', text: part.text };
        else yield { type: 'text', text: part.text };
      }
      const fc = part.functionCall as { name?: string; args?: unknown } | undefined;
      if (fc?.name) {
        calls.push({
          id: `call_${counter++}`,
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {})
        });
      }
    }

    const meta = event.usageMetadata as Record<string, number> | undefined;
    if (meta) {
      usage = {
        promptTokens: meta.promptTokenCount ?? 0,
        completionTokens: meta.candidatesTokenCount ?? 0,
        totalTokens: meta.totalTokenCount ?? 0,
        cachedTokens: meta.cachedContentTokenCount ?? 0
      };
    }
  }

  if (calls.length > 0) yield { type: 'toolCalls', calls };
  yield { type: 'usage', usage };
}

/**
 * ChatGPT subscription backend, which speaks the Responses API.
 *
 * Tool calls arrive as completed items rather than streamed argument deltas,
 * so there is nothing to accumulate — but the bearer token has to be fetched
 * per request, since it is refreshed out from under us in the background.
 */
async function* streamChatGpt(
  endpoint: ResolvedEndpoint,
  request: CompletionRequest
): AsyncGenerator<StreamEvent> {
  if (!endpoint.auth) {
    throw new LlmError('нет входа в ChatGPT — авторизуйтесь в настройках', 401, false);
  }
  const { token, accountId } = await endpoint.auth();
  const sessionId = newSessionId();

  const response = await postStream(
    buildChatUrl(endpoint.baseUrl, 'chatgpt', request.model),
    responsesHeaders({ token, accountId, sessionId }),
    buildResponsesPayload(request, { cacheKey: sessionId }),
    request.signal
  );

  const calls: ToolCall[] = [];
  let usage: Usage = { ...EMPTY_USAGE };

  for await (const data of sseLines(response.body!, request.signal)) {
    if (data === '[DONE]') break;
    const chunk = parseResponsesEvent(data);
    if (!chunk) continue;

    if (chunk.text) yield { type: 'text', text: chunk.text };
    if (chunk.reasoning) yield { type: 'reasoning', text: chunk.reasoning };
    if (chunk.toolCall) calls.push(chunk.toolCall);
    if (chunk.usage) usage = chunk.usage;
    if (chunk.failure) {
      throw new LlmError(chunk.failure.message, 502, chunk.failure.retryable);
    }
  }

  if (calls.length > 0) yield { type: 'toolCalls', calls };
  yield { type: 'usage', usage };
}

export function streamCompletion(
  endpoint: ResolvedEndpoint,
  request: CompletionRequest
): AsyncGenerator<StreamEvent> {
  const req: CompletionRequest = { ...request, messages: sanitizeMessages(request.messages) };
  switch (endpoint.provider) {
    case 'chatgpt':
      return streamChatGpt(endpoint, req);
    case 'anthropic':
      return streamAnthropic(endpoint, req);
    case 'ollama':
      return streamOllama(endpoint, req);
    case 'google':
      return streamGoogle(endpoint, req);
    default:
      return streamOpenAiCompatible(endpoint, req);
  }
}

/**
 * Tries endpoints in order, but only fails over before the model has produced
 * anything. Once tokens are flowing, switching would splice two different
 * answers together.
 */
export async function* streamWithFallback(
  endpoints: readonly ResolvedEndpoint[],
  requestFor: (endpoint: ResolvedEndpoint) => CompletionRequest
): AsyncGenerator<StreamEvent> {
  let lastError: Error | undefined;

  for (const endpoint of endpoints) {
    let produced = false;
    try {
      for await (const event of streamCompletion(endpoint, requestFor(endpoint))) {
        if (event.type === 'text' || event.type === 'toolCalls') produced = true;
        yield event;
      }
      return;
    } catch (err) {
      lastError = err as Error;
      if (produced) throw err;
      if (err instanceof LlmError && !err.retryable && endpoints.length > 1) continue;
      if ((err as Error).name === 'AbortError') throw err;
    }
  }

  throw lastError ?? new LlmError('нет доступных эндпоинтов', 503, false);
}
