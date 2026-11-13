import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { MemoryStore } from './memory/store.js';
import { createLLM } from './llm/provider.js';
import { tavilySearch } from './search/tavily.js';
import { runTurn, type AgentEvent } from './agent/agent.js';

const store = await new MemoryStore(config.dataFile).load();
const llm = createLLM();
const app = new Hono();
const require = createRequire(import.meta.url);

function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

app.get('/api/config', (c) =>
  c.json({
    provider: config.provider,
    mainModel: config.mainModel,
    fastModel: config.fastModel,
    hasLlmKey: config.hasLlmKey,
    providerKeyEnv: config.providerKeyEnv,
    hasSearchKey: Boolean(config.tavilyKey),
    allowTimeTravel: config.allowTimeTravel,
    defaultTimezone: config.defaultTimezone,
  }),
);

app.get('/api/threads', (c) => c.json(store.listThreads()));

app.get('/api/threads/:id', (c) => {
  const thread = store.getThread(c.req.param('id'));
  if (!thread) return c.json({ error: 'not found' }, 404);
  return c.json({ thread, messages: store.threadMessages(thread.id) });
});

/** The claims ledger, newest first: what the agent has asserted, when, and re-check results. */
app.get('/api/ledger', (c) => {
  const claims = [...store.allClaims()]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .map((cl) => ({
      ...cl,
      question: store.getEpisode(cl.episodeId)?.question ?? '',
      previousValue: cl.previousClaimId ? store.allClaims().find((p) => p.id === cl.previousClaimId)?.value : undefined,
    }));
  return c.json(claims);
});

app.post('/api/reset', async (c) => {
  await store.reset();
  return c.json({ ok: true });
});

app.post('/api/chat', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    threadId?: string;
    message?: string;
    timezone?: string;
    now?: string;
  };
  const message = (body.message ?? '').trim();
  if (!message) return c.json({ error: 'message is required' }, 400);
  if (message.length > 8000) return c.json({ error: 'message too long' }, 400);

  const timezone = isValidTimezone(body.timezone) ? body.timezone : config.defaultTimezone;
  // Time travel (for testing "last Tuesday" questions): the client may set the agent's clock.
  let now = new Date();
  if (config.allowTimeTravel && body.now && !Number.isNaN(Date.parse(body.now))) now = new Date(body.now);

  return streamSSE(c, async (sse) => {
    const abort = new AbortController();
    sse.onAbort(() => abort.abort());
    const send = (e: AgentEvent) => sse.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});

    if (!config.hasLlmKey) {
      await send({ type: 'error', message: `No model API key. Set ${config.providerKeyEnv} in .env and restart.` });
      return;
    }
    try {
      await runTurn({ llm, store, search: tavilySearch }, { threadId: body.threadId, message, now, timezone, signal: abort.signal }, send);
    } catch (err) {
      console.error(err);
      await send({ type: 'error', message: (err as Error).message });
    }
  });
});

app.get('/vendor/marked.js', async (c) => {
  // marked's package exports don't expose the UMD build, so resolve the package dir.
  const dir = dirname(dirname(require.resolve('marked')));
  const js = await readFile(join(dir, 'lib', 'marked.umd.js'), 'utf8');
  return c.body(js, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=3600' });
});
app.use('/*', serveStatic({ root: './public' }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n  Chat agent running → http://localhost:${info.port}\n`);
  console.log(`  model:  ${config.provider} · main=${config.mainModel} · fast=${config.fastModel}`);
  console.log(`  search: ${config.tavilyKey ? 'Tavily' : 'NOT CONFIGURED (set TAVILY_API_KEY)'}`);
  console.log(`  memory: ${config.dataFile}`);
  if (!config.hasLlmKey) console.log(`\n  ⚠  Set ${config.providerKeyEnv} in .env (copy .env.example → .env)\n`);
});
