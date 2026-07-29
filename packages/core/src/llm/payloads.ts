import { omitsTemperature, usesMaxCompletionTokens } from './providers.js';
import type { ChatMessage, ContentPart, CompletionRequest, ToolSchema } from './types.js';

/**
 * Three payload shapes cover every provider we support: OpenAI-compatible,
 * Anthropic Messages, Ollama native, plus Google's own. Everything else is a
 * dialect of the first.
 */

function partsOf(content: string | ContentPart[]): ContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// ---------------------------------------------------------------- OpenAI

export function buildOpenAiPayload(req: CompletionRequest, stream: boolean): Record<string, unknown> {
  const messages = req.messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: textOf(m.content) };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: textOf(m.content) || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments }
        }))
      };
    }
    const parts = partsOf(m.content);
    const hasImage = parts.some((p) => p.type === 'image');
    if (!hasImage) return { role: m.role, content: textOf(m.content) };
    return {
      role: m.role,
      content: parts.map((p) =>
        p.type === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } }
      )
    };
  });

  const payload: Record<string, unknown> = { model: req.model, messages, stream };
  if (stream) payload.stream_options = { include_usage: true };

  if (req.tools?.length) {
    payload.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
    payload.tool_choice = 'auto';
  }
  if (!omitsTemperature(req.model) && req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }
  if (req.maxTokens) {
    if (usesMaxCompletionTokens(req.model)) payload.max_completion_tokens = req.maxTokens;
    else payload.max_tokens = req.maxTokens;
  }
  return payload;
}

// ------------------------------------------------------------- Anthropic

export function buildAnthropicPayload(
  req: CompletionRequest,
  stream: boolean
): Record<string, unknown> {
  const system: unknown[] = [];
  const messages: unknown[] = [];

  for (const m of req.messages) {
    if (m.role === 'system') {
      const block: Record<string, unknown> = { type: 'text', text: textOf(m.content) };
      // Anthropic caches the prefix up to a breakpoint; the stable tier of our
      // system prompt is exactly what we want cached.
      if (m.cacheBreakpoint) block.cache_control = { type: 'ephemeral' };
      system.push(block);
      continue;
    }
    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: textOf(m.content) }]
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: unknown[] = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of m.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: safeJsonParse(call.arguments)
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: partsOf(m.content).map((p) =>
        p.type === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.base64 } }
      )
    });
  }

  const payload: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? 8192,
    stream
  };
  if (system.length > 0) payload.system = system;
  if (req.temperature !== undefined && !omitsTemperature(req.model)) {
    payload.temperature = req.temperature;
  }
  if (req.tools?.length) {
    payload.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
  }
  return payload;
}

// ---------------------------------------------------------------- Ollama

export function buildOllamaPayload(req: CompletionRequest, stream: boolean): Record<string, unknown> {
  const messages = req.messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: textOf(m.content) };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: textOf(m.content),
        tool_calls: m.toolCalls.map((c) => ({
          function: { name: c.name, arguments: safeJsonParse(c.arguments) }
        }))
      };
    }
    const parts = partsOf(m.content);
    const images = parts.filter((p) => p.type === 'image').map((p) => (p as { base64: string }).base64);
    const base: Record<string, unknown> = { role: m.role, content: textOf(m.content) };
    if (images.length > 0) base.images = images;
    return base;
  });

  const payload: Record<string, unknown> = {
    model: req.model,
    messages,
    stream,
    options: {
      temperature: req.temperature ?? 0.7,
      ...(req.maxTokens ? { num_predict: req.maxTokens } : {})
    }
  };
  if (req.tools?.length) {
    payload.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }
  return payload;
}

// ---------------------------------------------------------------- Google

export function buildGooglePayload(req: CompletionRequest): Record<string, unknown> {
  const contents: unknown[] = [];
  const systemParts: unknown[] = [];

  for (const m of req.messages) {
    if (m.role === 'system') {
      systemParts.push({ text: textOf(m.content) });
      continue;
    }
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'tool',
              response: { result: textOf(m.content) }
            }
          }
        ]
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      contents.push({
        role: 'model',
        parts: m.toolCalls.map((c) => ({
          functionCall: { name: c.name, args: safeJsonParse(c.arguments) }
        }))
      });
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: partsOf(m.content).map((p) =>
        p.type === 'text'
          ? { text: p.text }
          : { inlineData: { mimeType: p.mime, data: p.base64 } }
      )
    });
  }

  const payload: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: req.temperature ?? 0.7,
      maxOutputTokens: req.maxTokens ?? 8192
    }
  };
  if (systemParts.length > 0) payload.systemInstruction = { parts: systemParts };
  if (req.tools?.length) {
    payload.tools = [
      {
        functionDeclarations: req.tools.map((t: ToolSchema) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }))
      }
    ];
  }
  return payload;
}

export function safeJsonParse(text: string): unknown {
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Models occasionally emit a tool result without its call, or two assistant
 * turns in a row after an interrupt. Most providers reject that outright, so
 * we repair the sequence rather than lose the turn.
 */
export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const seenCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) seenCallIds.add(call.id);
      out.push(message);
      continue;
    }
    if (message.role === 'tool') {
      if (!message.toolCallId || !seenCallIds.has(message.toolCallId)) continue;
      out.push(message);
      continue;
    }
    out.push(message);
  }

  // Every announced call needs a result, or the next request 400s.
  const answered = new Set(out.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  const repaired: ChatMessage[] = [];
  for (const message of out) {
    repaired.push(message);
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) {
        if (!answered.has(call.id)) {
          repaired.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: 'Вызов прерван, результата нет.'
          });
        }
      }
    }
  }
  return repaired;
}
