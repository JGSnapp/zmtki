import { randomUUID } from 'node:crypto';
import type { CompletionRequest, ContentPart, ToolCall, Usage } from './types.js';

/**
 * Payload and event shapes for the OpenAI Responses API.
 *
 * The ChatGPT subscription backend speaks only this protocol — Chat Completions
 * is not available there — so the whole request has to be reshaped: history
 * becomes a flat list of typed input items, and tool results are their own item
 * kind rather than a message role.
 */

export interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

interface InputText {
  type: 'input_text' | 'output_text';
  text: string;
}

interface InputImage {
  type: 'input_image';
  image_url: string;
}

type InputContent = InputText | InputImage;

type InputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'developer'; content: InputContent[] }
  | { type: 'function_call'; name: string; arguments: string; call_id: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: InputItem[];
  tools: ResponsesTool[];
  tool_choice: string;
  parallel_tool_calls: boolean;
  store: boolean;
  stream: boolean;
  include: string[];
  prompt_cache_key?: string;
  reasoning?: { effort: string; summary: string };
}

function contentParts(content: string | ContentPart[], output: boolean): InputContent[] {
  if (typeof content === 'string') {
    return [{ type: output ? 'output_text' : 'input_text', text: content }];
  }
  return content.map((part) =>
    part.type === 'text'
      ? { type: output ? 'output_text' : 'input_text', text: part.text }
      : { type: 'input_image', image_url: `data:${part.mime};base64,${part.base64}` }
  );
}

/**
 * Flattens our chat history into Responses input items.
 *
 * System messages are hoisted into `instructions`, which is where this API
 * expects them; leaving them as items makes the model treat them as ordinary
 * turns and weakens the prompt.
 */
export function buildResponsesPayload(
  request: CompletionRequest,
  options: { cacheKey?: string; reasoningEffort?: string } = {}
): ResponsesRequest {
  const instructions: string[] = [];
  const input: InputItem[] = [];

  for (const message of request.messages) {
    if (message.role === 'system') {
      instructions.push(typeof message.content === 'string' ? message.content : textOf(message.content));
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: typeof message.content === 'string' ? message.content : textOf(message.content)
      });
      continue;
    }

    if (message.role === 'assistant') {
      const text = typeof message.content === 'string' ? message.content : textOf(message.content);
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: contentParts(text, true) });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          name: call.name,
          arguments: call.arguments,
          call_id: call.id
        });
      }
      continue;
    }

    input.push({ type: 'message', role: 'user', content: contentParts(message.content, false) });
  }

  const payload: ResponsesRequest = {
    model: request.model,
    instructions: instructions.join('\n\n'),
    input,
    tools: (request.tools ?? []).map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false
    })),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    // The subscription backend rejects stored responses.
    store: false,
    stream: true,
    // Without the encrypted reasoning the model loses its chain between rounds
    // of the same turn, which shows up as it redoing work it already did.
    include: ['reasoning.encrypted_content']
  };

  if (options.cacheKey) payload.prompt_cache_key = options.cacheKey;
  if (options.reasoningEffort) {
    payload.reasoning = { effort: options.reasoningEffort, summary: 'auto' };
  }
  return payload;
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export interface ResponsesHeaderOptions {
  token: string;
  accountId: string;
  sessionId: string;
}

export function responsesHeaders(options: ResponsesHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${options.token}`,
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/codex',
    'User-Agent': 'Artifact Board ChatGPT Subscription',
    'session-id': options.sessionId
  };
  if (options.accountId) headers['ChatGPT-Account-ID'] = options.accountId;
  return headers;
}

export function newSessionId(): string {
  return randomUUID();
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    id?: string;
  };
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
    error?: { message?: string; code?: string };
  };
  error?: { message?: string; code?: string };
}

export interface ResponsesChunk {
  text?: string;
  reasoning?: string;
  toolCall?: ToolCall;
  usage?: Usage;
  failure?: { message: string; retryable: boolean };
}

const RETRYABLE_CODES = new Set(['rate_limit_exceeded', 'server_overloaded', 'server_error']);

/** Translates one SSE payload into whatever it means for the caller, if anything. */
export function parseResponsesEvent(raw: string): ResponsesChunk | null {
  let event: ResponsesEvent;
  try {
    event = JSON.parse(raw) as ResponsesEvent;
  } catch {
    return null;
  }

  switch (event.type) {
    case 'response.output_text.delta':
      return event.delta ? { text: event.delta } : null;

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      return event.delta ? { reasoning: event.delta } : null;

    case 'response.output_item.done': {
      const item = event.item;
      if (item?.type !== 'function_call' || !item.name) return null;
      return {
        toolCall: {
          id: item.call_id ?? item.id ?? `call_${Date.now()}`,
          name: item.name,
          arguments: item.arguments || '{}'
        }
      };
    }

    case 'response.completed': {
      const usage = event.response?.usage;
      if (!usage) return null;
      const promptTokens = usage.input_tokens ?? 0;
      const completionTokens = usage.output_tokens ?? 0;
      return {
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
          cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0
        }
      };
    }

    case 'response.failed':
    case 'error': {
      const error = event.response?.error ?? event.error;
      const code = error?.code ?? '';
      return {
        failure: {
          message: error?.message ?? 'поток прерван провайдером',
          retryable: RETRYABLE_CODES.has(code)
        }
      };
    }

    default:
      return null;
  }
}

/** The subscription exposes its own model list, which differs by plan. */
export function extractChatGptModels(body: unknown): string[] {
  const container = body as { models?: unknown; data?: unknown };
  const list = (container.models ?? container.data ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(list)) return [];
  const slugs = list
    .map((entry) => entry.slug ?? entry.id ?? entry.name)
    .filter((slug): slug is string => typeof slug === 'string');
  return [...new Set(slugs)].sort();
}
