import type { z } from 'zod';

/**
 * The agent depends on this small interface, not on a model SDK.
 * - Swapping provider is one env var (see config.ts).
 * - Tests run the whole pipeline with a scripted fake (test/fakes.ts),
 *   with no API keys and no network.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type Tier = 'fast' | 'main';

export interface StructuredRequest<T> {
  tier: Tier;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  timeoutMs?: number;
}

export interface StreamRequest {
  system: string;
  messages: ChatMessage[];
  /** The web_search tool. Returns text the model reads (numbered sources). */
  webSearch?: (query: string, recentOnly: boolean) => Promise<string>;
  /** Max extra search rounds the model may do on its own while answering. */
  maxToolSteps?: number;
  signal?: AbortSignal;
  /** If streaming produces nothing for this long, retry without streaming. */
  stallTimeoutMs?: number;
}

export interface LLM {
  structured<T>(req: StructuredRequest<T>): Promise<T>;
  stream(req: StreamRequest): AsyncIterable<string>;
}
