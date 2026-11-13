import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';
import { resolveTimeRefs } from '../src/time/resolve.js';
import { runTurn, type AgentEvent } from '../src/agent/agent.js';
import { fakeLLM, fakeSearch, newCalls } from './fakes.js';

const TZ = 'Asia/Kolkata';
const TUE_10_NOV = new Date('2026-11-10T05:00:00Z'); // 10:30 IST
const THU_12_NOV = new Date('2026-11-12T17:00:00Z'); // 22:30 IST

function setup() {
  const store = new MemoryStore(null);
  const calls = newCalls();
  const world = { neonPrice: '$19' };
  const llm = fakeLLM(
    {
      answer: (req) =>
        req.system.includes('CHANGED')
          ? 'Yes — Neon Launch went from $19/month to $25/month [1].'
          : req.system.includes('Nothing stored from the date')
            ? 'I have no record of a conversation on 3 November.'
            : `Neon's Launch plan costs ${world.neonPrice}/month [1].`,
    },
    calls,
  );
  const deps = { llm, store, search: fakeSearch(world, calls) };
  return { store, calls, world, deps };
}

async function turn(deps: Parameters<typeof runTurn>[0], message: string, now: Date, threadId?: string) {
  const events: AgentEvent[] = [];
  const r = await runTurn(deps, { message, now, timezone: TZ, threadId }, (e) => events.push(e));
  await r.memorySaved;
  return { ...r, events };
}

test('a searched answer is stored as an episode with atomic claims', async () => {
  const { store, deps } = setup();
  const r = await turn(deps, 'What does Neon Postgres hosting cost?', TUE_10_NOV);
  assert.equal(r.mode, 'search');
  assert.match(r.answer, /\$19\/month/);
  const [ep] = store.episodes();
  assert.equal(ep!.topic, 'Postgres hosting pricing');
  const claims = store.claimsForEpisode(ep!.id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.value, '$19/month');
  assert.equal(claims[0]!.sourceUrl, 'https://neon.com/pricing');
  assert.equal(claims[0]!.observedAt, TUE_10_NOV.toISOString());
});

test('"Last Tuesday I asked… has pricing changed?" re-checks the stored claim and records the change', async () => {
  const { store, calls, world, deps } = setup();
  await turn(deps, 'What does Neon Postgres hosting cost?', TUE_10_NOV);

  world.neonPrice = '$25'; // the web changes between Tuesday and Thursday
  const r = await turn(deps, 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', THU_12_NOV);

  assert.equal(r.mode, 'recall_verify');
  const plan = r.events.find((e) => e.type === 'plan');
  assert.ok(plan && plan.type === 'plan' && plan.recalled.length === 1, 'recalled Tuesday’s episode');

  // Every subject got a fact query and a recent-news query, run as one fan-out.
  assert.ok(calls.searches.some((s) => s.opts?.topic === 'news'));

  const verification = r.events.find((e) => e.type === 'verification');
  assert.ok(verification && verification.type === 'verification');
  assert.equal(verification.report.checks[0]!.status, 'changed');
  assert.equal(verification.report.checks[0]!.now, '$25/month');

  // The ledger now holds the new value, linked to the old claim.
  const reverified = store.allClaims().filter((c) => c.origin === 'reverified');
  assert.equal(reverified.length, 1);
  assert.equal(reverified[0]!.value, '$25/month');
  assert.ok(reverified[0]!.previousClaimId);
  const original = store.allClaims().find((c) => c.id === reverified[0]!.previousClaimId)!;
  assert.equal(store.latestVersion(original).value, '$25/month');

  assert.match(r.answer, /\$19\/month to \$25\/month/);
});

test('a second re-check compares against the newest value, not the original', async () => {
  const { store, world, deps } = setup();
  await turn(deps, 'What does Neon Postgres hosting cost?', TUE_10_NOV);
  world.neonPrice = '$25';
  await turn(deps, 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', THU_12_NOV);
  const r = await turn(
    deps,
    'Last Tuesday I asked you about Postgres hosting. Has it changed since?',
    new Date('2026-11-12T18:00:00Z'),
  );
  const v = r.events.find((e) => e.type === 'verification');
  assert.ok(v && v.type === 'verification');
  assert.equal(v.report.checks[0]!.was, '$25/month');
  assert.equal(v.report.checks[0]!.status, 'unchanged');
  assert.equal(store.allClaims().filter((c) => c.origin === 'reverified').length, 2);
});

test('asking about a date with no conversation is answered honestly, not invented', async () => {
  const { deps, calls } = setup();
  await turn(deps, 'What does Neon Postgres hosting cost?', TUE_10_NOV);
  const r = await turn(deps, 'What did I ask you on 3 November? Is your answer still correct today?', THU_12_NOV);
  assert.ok(calls.streams.at(-1)!.system.includes('Nothing stored from the date'));
  assert.match(r.answer, /no record/);
});

test('retrieval: date filter first, then alternate reading, then lexical fallback', () => {
  const store = new MemoryStore(null);
  const mk = (q: string, at: string, topic: string) =>
    store.addEpisode({ threadId: 't', userMessageId: 'u', assistantMessageId: 'a', askedAt: at, question: q, topic, entities: [], mode: 'search' });
  const crm = mk('Shortlist CRM tools for 20 sales reps', '2026-11-09T06:00:00Z', 'CRM shortlist');
  const pg = mk('Cheapest managed Postgres?', '2026-11-03T06:00:00Z', 'Postgres hosting');

  const onMonday = retrieve(store, 'On Monday we shortlisted CRMs', resolveTimeRefs('On Monday we shortlisted CRMs', THU_12_NOV, TZ), THU_12_NOV);
  assert.deepEqual(onMonday.candidates.map((c) => c.episode.id), [crm.id]);

  // Nothing on Tue 10 Nov → falls back to the alternate reading, Tue 3 Nov.
  const q = 'Last Tuesday I asked about Postgres hosting';
  const lastTue = retrieve(store, q, resolveTimeRefs(q, THU_12_NOV, TZ), THU_12_NOV);
  assert.deepEqual(lastTue.candidates.map((c) => c.episode.id), [pg.id]);
  assert.equal(lastTue.matchedRanges[0]!.label, 'Tuesday 3 November 2026');

  // No date: lexical relevance across all history.
  const noDate = retrieve(store, 'the postgres hosts you suggested', [], THU_12_NOV);
  assert.equal(noDate.candidates[0]!.episode.id, pg.id);

  // "still correct today" must not restrict memory to today.
  const today = 'Is the CRM shortlist still correct today?';
  const t = retrieve(store, today, resolveTimeRefs(today, THU_12_NOV, TZ), THU_12_NOV);
  assert.equal(t.candidates[0]!.episode.id, crm.id);
});
