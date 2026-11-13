import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemoryStore } from '../src/memory/store.js';
import { createMcpServer } from '../src/mcp/server.js';

const NOW = new Date('2026-11-12T17:00:00Z');

async function connect(store: MemoryStore) {
  const server = createMcpServer({ loadStore: async () => store, now: () => NOW, timezone: 'Asia/Kolkata' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return r.content[0]!.text;
  };
  return { client, call };
}

function seed() {
  const store = new MemoryStore(null);
  const ep = store.addEpisode({
    threadId: 't', userMessageId: 'u', assistantMessageId: 'a', askedAt: '2026-11-10T05:00:00Z',
    question: 'Compare Postgres hosting prices', topic: 'Postgres hosting', entities: ['Neon'], answerSummary: 'Neon Launch is $19/month.', mode: 'search',
  });
  const [orig] = store.addClaims([{ episodeId: ep.id, subject: 'Neon', attribute: 'Launch plan price', value: '$19/month', observedAt: '2026-11-10T05:00:00Z', origin: 'stated', sourceUrl: 'https://neon.com/pricing' }]);
  store.addClaims([{ episodeId: 'x', subject: 'Neon', attribute: 'Launch plan price', value: '$25/month', observedAt: '2026-11-12T17:00:00Z', origin: 'reverified', status: 'changed', previousClaimId: orig!.id }]);
  store.addClaims([{ episodeId: ep.id, subject: 'Supabase', attribute: 'Pro plan price', value: '$25/month', observedAt: '2026-11-01T05:00:00Z', origin: 'stated' }]);
  return store;
}

test('MCP server lists its three read-only tools', async () => {
  const { client } = await connect(seed());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['fact_history', 'recall_conversations', 'stale_facts']);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
});

test('recall_conversations resolves "last Tuesday" and returns the stored facts', async () => {
  const { call } = await connect(seed());
  const out = await call('recall_conversations', { query: 'postgres', when: 'last Tuesday' });
  assert.match(out, /Tuesday 10 November 2026/);
  assert.match(out, /Compare Postgres hosting prices/);
  assert.match(out, /Neon · Launch plan price: \$19\/month/);
});

test('fact_history shows the value changing over time', async () => {
  const { call } = await connect(seed());
  const out = await call('fact_history', { subject: 'neon' });
  assert.match(out, /10 Nov 2026 · \$19\/month \(stated/);
  assert.match(out, /12 Nov 2026 · \$25\/month \(re-check: changed/);
});

test('stale_facts lists only facts not re-checked recently', async () => {
  const { call } = await connect(seed());
  const out = await call('stale_facts', { olderThanDays: 7 });
  assert.match(out, /Supabase/);
  assert.doesNotMatch(out, /Neon/); // re-checked today
});
