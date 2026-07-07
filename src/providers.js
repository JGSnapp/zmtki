// Provider abstraction for the built-in agents.
//
// Agents need to call an LLM and (optionally) get tool-call requests back. Rather
// than pulling in provider-specific SDKs, this module speaks directly to each
// provider's HTTP API with fetch (Node >= 20). Three provider kinds are supported:
//
//   • "openai"   — any OpenAI-compatible /v1/chat/completions endpoint
//                  (api.openai.com, OpenRouter, local servers like llama.cpp,
//                  vLLM, Ollama's openai-compatible port, etc.).
//   • "anthropic" — Anthropic Messages API (/v1/messages).
//   • "codex"    — a Zmtki-side convention for "Codex" style access: it stores
//                  either an OAuth-ish bearer token or reuses an OpenAI-compatible
//                  base URL + token. Practically it is run through the OpenAI
//                  adapter so any compliant gateway works.
//
// Settings are loaded/written through store.readProviders / writeProviders. The
// module never logs secrets. All adapters return a normalized shape:
//
//   { content: string, toolCalls: [{ name, args: object }], usage?: {...} }

import { readProviders } from "./store.js";

const DEFAULT_TIMEOUT_MS = 120000;

// ---------- settings access ----------
export async function listProviders() {
  const data = await readProviders();
  // Never hand API keys back to the client in full — mask them.
  return {
    activeId: data.activeId || "",
    providers: (data.providers || []).map((p) => ({ ...p, apiKey: maskKey(p.apiKey) }))
  };
}

function maskKey(key) {
  if (!key) return "";
  const s = String(key);
  if (s.length <= 8) return "•".repeat(s.length);
  return s.slice(0, 4) + "…" + s.slice(-4);
}

// Resolve a full provider record (with the real key) by id, falling back to the
// active one. Throws if none is configured.
async function resolveProvider(providerId = "") {
  const data = await readProviders();
  let provider = null;
  if (providerId) provider = data.providers.find((p) => p.id === providerId);
  if (!provider) provider = data.providers.find((p) => p.id === data.activeId);
  if (!provider) provider = data.providers[0];
  if (!provider) {
    throw new Error("No provider configured. Add one in Settings → Providers.");
  }
  return provider;
}

export async function resolveProviderRecord(providerId = "") {
  return resolveProvider(providerId);
}

// ---------- public entry point ----------
// messages: [{ role: "system"|"user"|"assistant"|"tool", content, name?, tool_call_id? }]
// options:  { providerId?, model?, tools?: [{name, description, parameters}], images?: [dataUrl], temperature?, maxTokens? }
export async function chatComplete(messages, options = {}) {
  const provider = await resolveProvider(options.providerId);
  const model = options.model || provider.model || defaultModel(provider);
  if (provider.kind === "anthropic") {
    return anthropicChat(provider, model, messages, options);
  }
  // "openai" and "codex" both go through the OpenAI-compatible path.
  return openaiChat(provider, model, messages, options);
}

function defaultModel(provider) {
  if (provider.kind === "anthropic") return "claude-3-5-sonnet-latest";
  return "gpt-4o-mini";
}

function baseUrl(provider) {
  let url = String(provider.baseUrl || "").trim();
  if (!url) {
    url = provider.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
  }
  return url.replace(/\/+$/, "");
}

async function withTimeout(promiseFactory, ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promiseFactory(controller);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- OpenAI-compatible ----------
async function openaiChat(provider, model, messages, options) {
  const url = `${baseUrl(provider)}/v1/chat/completions`;
  const body = {
    model,
    messages: messages
      // drop empty tool-result stubs the agent may have produced
      .filter((m) => m.content !== null && m.content !== undefined || m.role === "tool")
      .map(toOpenaiMessage),
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens
  };
  if (options.images?.length) attachVisionImages(body.messages, options.images, "openai");
  if (options.tools?.length) {
    body.tools = options.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters || { type: "object", properties: {} } }
    }));
    body.tool_choice = "auto";
  }
  const data = await withTimeout(async (controller) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.extraHeaders || {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`OpenAI provider error ${res.status}: ${await safeText(res)}`);
    return res.json();
  });
  const choice = data.choices?.[0]?.message || {};
  const toolCalls = (choice.tool_calls || []).map((tc) => ({
    name: tc.function?.name || "",
    args: safeParseJson(tc.function?.arguments || "{}")
  }));
  return {
    content: choice.content || "",
    toolCalls,
    usage: data.usage || null,
    raw: { provider: "openai", model, finish: data.choices?.[0]?.finish_reason }
  };
}

function toOpenaiMessage(m) {
  if (m.role === "tool") {
    return { role: "tool", content: String(m.content ?? ""), tool_call_id: m.tool_call_id || "" };
  }
  if (m.role === "assistant" && m.tool_calls) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id || "call",
        type: "function",
        function: { name: tc.name, arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}) }
      }))
    };
  }
  return { role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") };
}

// ---------- Anthropic ----------
async function anthropicChat(provider, model, messages, options) {
  const url = `${baseUrl(provider)}/v1/messages`;
  // Split out the system prompt; Anthropic takes it as a top-level field.
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const convo = messages.filter((m) => m.role !== "system");
  const body = {
    model,
    max_tokens: options.maxTokens || 1024,
    temperature: options.temperature ?? 0.2,
    system: sys || undefined,
    messages: convo.map(toAnthropicMessage)
  };
  if (options.images?.length) attachVisionImages(body.messages, options.images, "anthropic");
  if (options.tools?.length) {
    body.tools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || { type: "object", properties: {} }
    }));
  }
  const data = await withTimeout(async (controller) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        ...(provider.extraHeaders || {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Anthropic provider error ${res.status}: ${await safeText(res)}`);
    return res.json();
  });
  // Anthropic returns content blocks. Tool-use blocks become toolCalls.
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ name: b.name, args: b.input || {} }));
  return {
    content: text,
    toolCalls,
    usage: data.usage || null,
    raw: { provider: "anthropic", model, stop: data.stop_reason }
  };
}

function toAnthropicMessage(m) {
  if (m.role === "tool") {
    return { role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id || "", content: String(m.content ?? "") }] };
  }
  if (m.role === "assistant" && m.tool_calls?.length) {
    const blocks = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const tc of m.tool_calls) {
      blocks.push({ type: "tool_use", id: tc.id || "toolu", name: tc.name, input: tc.args || {} });
    }
    return { role: "assistant", content: blocks };
  }
  return { role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") };
}

// Attach image content blocks for vision-capable models. We only send images
// when the caller explicitly passes them (the agent requested a snapshot).
function attachVisionImages(messages, images, style) {
  if (!images?.length) return;
  // Find the latest user message and append image content to it.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (style === "openai" && m.role === "user") {
      const imgParts = images.map((url) => ({ type: "image_url", image_url: { url } }));
      m.content = [
        { type: "text", text: typeof m.content === "string" ? m.content : "" },
        ...imgParts
      ];
      return;
    }
    if (style === "anthropic" && (m.role === "user")) {
      const imgParts = images.map((url) => dataUrlToAnthropicImage(url)).filter(Boolean);
      m.content = [
        { type: "text", text: typeof m.content === "string" ? m.content : "" },
        ...imgParts
      ];
      return;
    }
  }
}

function dataUrlToAnthropicImage(url) {
  const m = String(url || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

// ---------- helpers ----------
function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 500); } catch { return ""; }
}

// Generate an image via OpenAI-compatible /v1/images/generations.
export async function generateImage(prompt, options = {}) {
  const provider = await resolveProvider(options.providerId);
  const url = `${baseUrl(provider)}/v1/images/generations`;
  const body = {
    model: options.model || provider.imageModel || "dall-e-3",
    prompt: String(prompt || ""),
    n: 1,
    size: options.size || "1024x1024",
    response_format: "b64_json"
  };
  try {
    const data = await withTimeout(async (controller) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
          ...(provider.extraHeaders || {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Image generation error ${res.status}: ${await safeText(res)}`);
      return res.json();
    });
    const item = data.data?.[0];
    if (!item?.b64_json) return { error: "Provider returned no image data" };
    return {
      base64: item.b64_json,
      revisedPrompt: item.revised_prompt || prompt,
      raw: { provider: provider.kind, model: body.model }
    };
  } catch (error) {
    return { error: error.message };
  }
}

// Quick connectivity probe used by the settings UI ("Test" button).
export async function testProvider(providerInput) {
  const provider = providerInput;
  try {
    const r = await chatComplete(
      [{ role: "user", content: "Reply with the single word: ok" }],
      { providerId: provider.id, maxTokens: 16 }
    );
    return { ok: true, content: r.content, raw: r.raw };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
