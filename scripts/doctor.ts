/**
 * npm run doctor — checks the setup piece by piece and prints what is wrong.
 * Never prints API keys.
 */
import { config } from '../src/config.js';
import { createLLM } from '../src/llm/provider.js';
import { tavilySearch } from '../src/search/tavily.js';
import { z } from 'zod';
import { generateText, streamText } from 'ai';

const ok = (s: string) => console.log(`  ✅ ${s}`);
const bad = (s: string) => console.log(`  ❌ ${s}`);
const time = async <T>(fn: () => Promise<T>) => {
  const t = Date.now();
  const v = await fn();
  return { v, ms: Date.now() - t };
};
const errText = (e: unknown) => {
  const o = e as { message?: string; statusCode?: number; responseBody?: string; cause?: { message?: string } };
  return [o.statusCode && `HTTP ${o.statusCode}`, o.message, o.cause?.message, o.responseBody?.slice(0, 300)].filter(Boolean).join(' — ');
};

console.log(`\nNode ${process.version}`);
console.log(`Provider: ${config.provider} · main=${config.mainModel} · fast=${config.fastModel}\n`);

console.log('1. Keys in .env');
config.hasLlmKey ? ok(`${config.providerKeyEnv} is set`) : bad(`${config.providerKeyEnv} is missing`);
config.tavilyKey ? ok('TAVILY_API_KEY is set') : bad('TAVILY_API_KEY is missing');

const llm = createLLM();

console.log('\n2. Fast model (planning)');
try {
  const { v, ms } = await time(() =>
    llm.structured({ tier: 'fast', schema: z.object({ answer: z.string() }), system: 'Reply in JSON.', prompt: 'Say "ok".', timeoutMs: 30_000 }),
  );
  ok(`replied ${JSON.stringify(v)} in ${ms} ms`);
} catch (e) {
  bad(errText(e));
}

// Each model is tried both ways, so we can tell "the model is broken" apart
// from "this network blocks streamed responses".
const google = (await import('@ai-sdk/google')).google;
const openai = (await import('@ai-sdk/openai')).openai;
const anthropic = (await import('@ai-sdk/anthropic')).anthropic;
const make = (id: string) => (config.provider === 'openai' ? openai(id) : config.provider === 'anthropic' ? anthropic(id) : google(id));

async function probe(label: string, id: string) {
  console.log(`\n3. ${label}: ${id}`);
  try {
    const { v, ms } = await time(() =>
      generateText({ model: make(id), prompt: 'Say hello in 3 words.', abortSignal: AbortSignal.timeout(30_000), maxRetries: 0 }),
    );
    v.text ? ok(`normal request: "${v.text.trim().slice(0, 40)}" in ${ms} ms`) : bad(`normal request: empty reply (finish: ${v.rawFinishReason ?? v.finishReason})`);
  } catch (e) {
    bad(`normal request: ${errText(e)}`);
  }
  const t = Date.now();
  let text = '';
  let firstMs = 0;
  let failure = '';
  try {
    const r = streamText({ model: make(id), prompt: 'Say hello in 3 words.', abortSignal: AbortSignal.timeout(25_000), maxRetries: 0, onError: () => {} });
    for await (const part of r.fullStream) {
      if (part.type === 'text-delta') {
        if (!firstMs) firstMs = Date.now() - t;
        text += part.text;
      } else if (part.type === 'error') failure = errText(part.error);
      else if (part.type === 'abort') failure = 'no data for 25 s (stream blocked or stalled)';
    }
  } catch (e) {
    failure = errText(e);
  }
  if (text) ok(`streamed: "${text.trim().slice(0, 40)}", first word after ${firstMs} ms`);
  else bad(`streamed: ${failure || 'empty reply'}`);
}
await probe('Main model', config.mainModel);
await probe('Fast model', config.fastModel);

console.log('\n4. Full answer path (with automatic fallback to the fast model)');
try {
  const { v, ms } = await time(async () => {
    let s = '';
    for await (const c of llm.stream({ system: 'Be brief.', messages: [{ role: 'user', content: 'Say hello in 3 words.' }] })) s += c;
    return s;
  });
  ok(`answered "${v.trim().slice(0, 50)}" in ${ms} ms`);
} catch (e) {
  bad(errText(e));
}

console.log('\n5. Web search (Tavily)');
const { v: r, ms } = await time(() => tavilySearch('Node.js LTS version', { maxResults: 2 }));
r.error ? bad(r.error) : ok(`${r.results.length} results in ${ms} ms (first: ${r.results[0]?.title ?? '—'})`);

console.log('\nIf a model step failed with "not found" or "model", set MAIN_MODEL / FAST_MODEL in .env (the error message usually names the model to use).\n');
