import { generateText, Output, stepCountIs, streamText, tool, type LanguageModel } from 'ai';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { config } from '../config.js';
import type { LLM, StreamRequest, StructuredRequest, Tier } from './types.js';

function model(tier: Tier): LanguageModel {
  const id = tier === 'main' ? config.mainModel : config.fastModel;
  switch (config.provider) {
    case 'openai':
      return openai(id);
    case 'anthropic':
      return anthropic(id);
    default:
      return google(id);
  }
}

/** Gemini "thinks" by default; routing/extraction don't need it, answers need a little. */
function providerOptions(tier: Tier) {
  return {
    google: { thinkingConfig: { thinkingLevel: tier === 'fast' ? 'minimal' : 'low' } },
  } as const;
}

/** `modelFor` is injectable so the SDK glue can be tested with mock models. */
/** Model is overloaded, rate-limited, down, silent or unknown (404): worth trying the other model. */
export function isCapacityError(e: unknown): boolean {
  const o = (e ?? {}) as { statusCode?: number; message?: string; lastError?: unknown };
  if (o.lastError && isCapacityError(o.lastError)) return true;
  if (o.statusCode && [404, 429, 500, 502, 503, 504, 529].includes(o.statusCode)) return true;
  // A model that times out or never starts responding counts too.
  return /high demand|overloaded|unavailable|rate limit|quota|resource.?exhausted|try again later|timeout|timed out|stalled|not found|\b(429|503|529)\b/i.test(
    o.message ?? String(e),
  );
}

/** "Please retry in 20.5s" / retryDelay "20s" → ms, if the provider said how long to wait. */
export function retryAfterMs(e: unknown): number | undefined {
  const o = (e ?? {}) as { message?: string; responseBody?: string; lastError?: unknown };
  const text = `${o.message ?? ''} ${o.responseBody ?? ''} ${o.lastError ? describeError(o.lastError) : ''}`;
  const m = text.match(/retry in ([\d.]+)\s*s/i) ?? text.match(/"retryDelay":\s*"([\d.]+)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Free tiers rate-limit per minute. When the provider says "retry in N s" and N is short, wait once. */
const MAX_RATE_LIMIT_WAIT_MS = 25_000;

function describeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { message?: string; responseBody?: string; statusCode?: number };
    return [o.statusCode && `HTTP ${o.statusCode}`, o.message, o.responseBody?.slice(0, 300)]
      .filter(Boolean)
      .join(' — ');
  }
  return String(e);
}

export function createLLM(modelFor: (tier: Tier) => LanguageModel = model, opts: { cooldownMs?: number } = {}): LLM {
  // Circuit breaker: after the main model fails for capacity reasons, skip it
  // for a few minutes instead of paying the failure latency on every turn.
  const COOLDOWN_MS = opts.cooldownMs ?? 5 * 60_000;
  let mainSkippedUntil = 0;
  const mainAvailable = () => Date.now() >= mainSkippedUntil;
  const tripBreaker = (err: unknown) => {
    mainSkippedUntil = Date.now() + COOLDOWN_MS;
    console.warn(
      `[llm] main model busy (${describeError(err).slice(0, 80)}); using the fast model for the next ${COOLDOWN_MS / 60_000} min`,
    );
  };

  return {
    async structured<T>(req: StructuredRequest<T>): Promise<T> {
      if (req.tier === 'main' && !mainAvailable()) return withRateLimitWait(() => structuredWith('fast', req));
      try {
        return await (req.tier === 'fast' ? withRateLimitWait(() => structuredWith('fast', req)) : structuredWith('main', req));
      } catch (err) {
        if (req.tier !== 'main' || !isCapacityError(err)) throw err;
        tripBreaker(err);
        return withRateLimitWait(() => structuredWith('fast', req));
      }
    },

    async *stream(req: StreamRequest): AsyncIterable<string> {
      if (!mainAvailable()) {
        yield* fastStreamWithWait(req);
        return;
      }
      let yielded = false;
      try {
        for await (const chunk of streamWith('main', req)) {
          yielded = true;
          yield chunk;
        }
      } catch (err) {
        if (yielded || req.signal?.aborted || !isCapacityError(err)) throw err;
        tripBreaker(err);
        yield* fastStreamWithWait(req);
      }
    },
  };

  async function withRateLimitWait<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const wait = retryAfterMs(err);
      if (wait === undefined || wait > MAX_RATE_LIMIT_WAIT_MS) throw err;
      console.warn(`[llm] rate-limited; provider asked to retry in ${(wait / 1000).toFixed(0)}s, waiting once`);
      await sleep(wait + 500);
      return fn();
    }
  }

  async function* fastStreamWithWait(req: StreamRequest): AsyncIterable<string> {
    let yielded = false;
    try {
      for await (const chunk of streamWith('fast', req)) {
        yielded = true;
        yield chunk;
      }
    } catch (err) {
      const wait = retryAfterMs(err);
      if (yielded || req.signal?.aborted || wait === undefined || wait > MAX_RATE_LIMIT_WAIT_MS) throw err;
      console.warn(`[llm] rate-limited; provider asked to retry in ${(wait / 1000).toFixed(0)}s, waiting once`);
      await sleep(wait + 500);
      yield* streamWith('fast', req);
    }
  }

  async function structuredWith<T>(tier: Tier, req: StructuredRequest<T>): Promise<T> {
    const result = await generateText({
      model: modelFor(tier),
      system: req.system,
      prompt: req.prompt,
      output: Output.object({ schema: req.schema }),
      providerOptions: providerOptions(tier),
      abortSignal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
      maxRetries: tier === 'main' ? 0 : 1, // main fails over to fast instead of backing off
    });
    return result.output as T;
  }

  async function* streamWith(tier: Tier, req: StreamRequest): AsyncIterable<string> {
    const tools = req.webSearch
      ? {
          web_search: tool({
            description:
              'Search the web. Use only if the evidence already provided is missing something the user asked for. ' +
              'Results are numbered sources you can cite as [n].',
            inputSchema: z.object({
              query: z.string().describe('A specific search query, like a person would type into a search engine.'),
              recentOnly: z.boolean().describe('true to restrict to news/pages from the last month'),
            }),
            execute: async ({ query, recentOnly }) => req.webSearch!(query, recentOnly),
          }),
        }
      : undefined;

    const common = {
      model: modelFor(tier),
      system: req.system,
      messages: req.messages,
      tools,
      stopWhen: stepCountIs((req.maxToolSteps ?? 2) + 1),
      providerOptions: providerOptions(tier),
      maxRetries: tier === 'main' ? 0 : 1, // main fails over to fast instead of backing off
    };

    // 1) Try streaming. Some networks (college/office proxies, antivirus)
    //    buffer streamed responses, so nothing arrives. If no event shows up
    //    within FIRST_EVENT_MS, abort and fall back to one normal request.
    // Main model: a first-token budget. A healthy model starts in 1–3 s; past
    // this, an overloaded one is better replaced than waited for. The fast
    // model gets longer, since after it only the non-streaming retry is left.
    const FIRST_EVENT_MS = req.stallTimeoutMs ?? (tier === 'main' ? 6_000 : 12_000);
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort();
    req.signal?.addEventListener('abort', onOuterAbort);
    let sawEvent = false;
    let gotText = false;
    let finishReason = 'unknown';
    let stalled = false;
    const timer = setTimeout(() => {
      if (!sawEvent) {
        stalled = true;
        ctrl.abort(new Error('stream stalled'));
      }
    }, FIRST_EVENT_MS);

    try {
      const result = streamText({ ...common, abortSignal: ctrl.signal, onError: () => {} });
      for await (const part of result.fullStream) {
        // Only output from the model counts as progress (start/abort/error are not).
        if (/^(text|reasoning|tool|source|file|finish)/.test(part.type)) sawEvent = true;
        if (part.type === 'text-delta' && part.text) {
          gotText = true;
          yield part.text;
        } else if (part.type === 'error') {
          throw new Error(describeError(part.error));
        } else if (part.type === 'abort') {
          if (stalled) break; // our stall timer fired → fall back below
          throw new Error(`model call aborted${part.reason ? `: ${part.reason}` : ''}`);
        } else if (part.type === 'finish') {
          finishReason = part.rawFinishReason ?? part.finishReason;
        }
      }
    } catch (err) {
      if (!stalled) throw err; // a real provider error: report it
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (stalled) {
      // The main model went silent: most often it is overloaded. Let the caller
      // fail over to the fast model (streamed) instead of waiting longer.
      if (tier === 'main') throw new Error(`main model stalled: no response in ${FIRST_EVENT_MS / 1000}s`);
      // The fast model stalled too: the network may be buffering streamed
      // responses (some proxies do). Same call without streaming.
      console.warn('[answer] streaming stalled, falling back to a non-streaming request');
      const r = await generateText({
        ...common,
        abortSignal: AbortSignal.any([AbortSignal.timeout(60_000), ...(req.signal ? [req.signal] : [])]),
      });
      if (!r.text) throw new Error(`the model returned an empty answer (finish reason: ${r.rawFinishReason ?? r.finishReason})`);
      yield r.text;
      return;
    }
    if (!gotText) throw new Error(`the model returned an empty answer (finish reason: ${finishReason})`);
  }
}
