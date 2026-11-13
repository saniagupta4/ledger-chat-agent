import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import { createLLM } from '../src/llm/provider.js';

// Checks the glue to the AI SDK (structured output + streaming with the
// web_search tool) against mock models, so it is tested without API keys.

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const stop = { unified: 'stop', raw: 'stop' };

test('structured() parses JSON output against the schema', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () =>
      ({ content: [{ type: 'text', text: '{"mode":"search","n":2}' }], finishReason: stop, usage, warnings: [] }) as never,
  });
  const llm = createLLM(() => model);
  const out = await llm.structured({ tier: 'fast', schema: z.object({ mode: z.string(), n: z.number() }), system: 's', prompt: 'p' });
  assert.deepEqual(out, { mode: 'search', n: 2 });
});

test('stream() runs a web_search tool call, then streams the final text', async () => {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      call++;
      const parts: unknown[] =
        call === 1
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'web_search', input: JSON.stringify({ query: 'neon price', recentOnly: true }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'Neon is ' },
              { type: 'text-delta', id: 't', delta: '$19 [1].' },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: stop, usage },
            ];
      return { stream: convertArrayToReadableStream(parts) } as never;
    },
  });
  const searched: Array<[string, boolean]> = [];
  const llm = createLLM(() => model);
  let text = '';
  for await (const chunk of llm.stream({
    system: 's',
    messages: [{ role: 'user', content: 'how much is neon?' }],
    webSearch: async (q, recent) => {
      searched.push([q, recent]);
      return '[1] Neon pricing — $19/month';
    },
  })) text += chunk;
  assert.deepEqual(searched, [['neon price', true]]);
  assert.equal(text, 'Neon is $19 [1].');
});

test('stream() turns a provider error into a thrown error (never a silent empty answer)', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: { statusCode: 400, message: 'API key not valid' } },
        ]),
      }) as never,
  });
  const llm = createLLM(() => model);
  await assert.rejects(async () => {
    for await (const _ of llm.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] }));
  }, /API key not valid/);
});

test('stream() reports an empty answer as an error', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'finish', finishReason: { unified: 'other', raw: 'SAFETY' }, usage },
        ]),
      }) as never,
  });
  const llm = createLLM(() => model);
  await assert.rejects(async () => {
    for await (const _ of llm.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] }));
  }, /empty answer \(finish reason: SAFETY\)/);
});

test('stream() falls back to a normal request when streaming stalls (proxies that buffer SSE)', async () => {
  const model = new MockLanguageModelV4({
    // A stream that never sends anything, like a buffering proxy.
    doStream: async ({ abortSignal }) =>
      ({
        stream: new ReadableStream({
          start(controller) {
            abortSignal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        }),
      }) as never,
    doGenerate: async () =>
      ({ content: [{ type: 'text', text: 'Hello from the fallback.' }], finishReason: stop, usage, warnings: [] }) as never,
  });
  const llm = createLLM(() => model);
  let text = '';
  const t = Date.now();
  for await (const c of llm.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], stallTimeoutMs: 200 })) text += c;
  assert.equal(text, 'Hello from the fallback.');
  assert.ok(Date.now() - t < 3000);
});

test('when the main model is overloaded, the answer comes from the fast model', async () => {
  const busy = new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: { statusCode: 503, message: 'This model is currently experiencing high demand.' } },
        ]),
      }) as never,
    doGenerate: async () => {
      throw Object.assign(new Error('This model is currently experiencing high demand.'), { statusCode: 503 });
    },
  });
  const fast = new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Answer from the backup model.' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: stop, usage },
        ]),
      }) as never,
    doGenerate: async () =>
      ({ content: [{ type: 'text', text: '{"ok":true}' }], finishReason: stop, usage, warnings: [] }) as never,
  });
  const llm = createLLM((tier) => (tier === 'main' ? busy : fast));
  let text = '';
  for await (const c of llm.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) text += c;
  assert.equal(text, 'Answer from the backup model.');
  const out = await llm.structured({ tier: 'main', schema: z.object({ ok: z.boolean() }), system: 's', prompt: 'p' });
  assert.deepEqual(out, { ok: true });
});

test('when the main model goes silent, the fast model answers (streamed) after the stall timeout', async () => {
  const silent = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) =>
      ({
        stream: new ReadableStream({
          start(controller) {
            abortSignal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        }),
      }) as never,
  });
  const fast = new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Fast model here.' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: stop, usage },
        ]),
      }) as never,
  });
  const llm = createLLM((tier) => (tier === 'main' ? silent : fast));
  let text = '';
  for await (const c of llm.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }], stallTimeoutMs: 200 })) text += c;
  assert.equal(text, 'Fast model here.');
});

test('after the main model fails, it is skipped for a while (no repeated slow failures)', async () => {
  let mainCalls = 0;
  const busy = new MockLanguageModelV4({
    doStream: async () => {
      mainCalls++;
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: { statusCode: 503, message: 'high demand' } },
        ]),
      } as never;
    },
  });
  const fast = new MockLanguageModelV4({
    doStream: async () =>
      ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'ok' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: stop, usage },
        ]),
      }) as never,
  });
  const llm = createLLM((tier) => (tier === 'main' ? busy : fast), { cooldownMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    let text = '';
    for await (const c of llm.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) text += c;
    assert.equal(text, 'ok');
  }
  assert.equal(mainCalls, 1);
});

test('rate limits: when the provider says "retry in N s", wait once and retry', async () => {
  let calls = 0;
  const limited = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      if (calls <= 2) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: { statusCode: 429, message: 'Quota exceeded. Please retry in 0.2s.' } },
          ]),
        } as never;
      }
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'after the wait' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: stop, usage },
        ]),
      } as never;
    },
  });
  // main (call 1) is rate-limited → fails over to fast (call 2), also limited → waits → call 3 succeeds
  const llm = createLLM(() => limited);
  let text = '';
  for await (const c of llm.stream({ system: 's', messages: [{ role: 'user', content: 'hi' }] })) text += c;
  assert.equal(text, 'after the wait');
  assert.equal(calls, 3);
});
