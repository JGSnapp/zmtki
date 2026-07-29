export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; base64: string };

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  /** Set on tool results to link them back to the call. */
  toolCallId?: string;
  name?: string;
  /**
   * Marks a prefix boundary for providers that support explicit prompt cache
   * breakpoints (Anthropic). Ignored elsewhere.
   */
  cacheBreakpoint?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export type StreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'toolCalls'; calls: ToolCall[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; message: string; retryable: boolean };

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ResolvedEndpoint {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  provider: ProviderId;
  /**
   * Subscription auth. Called per request rather than resolved up front,
   * because the bearer token is short-lived and refreshed in the background.
   */
  auth?: () => Promise<{ token: string; accountId: string }>;
}

export type ProviderId =
  | 'openai'
  | 'chatgpt'
  | 'anthropic'
  | 'google'
  | 'ollama'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'together'
  | 'local';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
