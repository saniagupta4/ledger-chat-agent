/**
 * npm run eval:live — end-to-end evaluation with the REAL model and search.
 *
 * 1. Builds a history by running the agent with its clock set to earlier days.
 * 2. Asks follow-up questions "today" and checks, for each:
 *      - did it take the right path (direct / search / recall / recall_verify)?
 *      - did it recall the right earlier conversation (or honestly none)?
 *      - are web answers cited?
 *      - how fast was the first word, and the full answer?
 * Uses an in-memory store, so your real chat history is untouched.
 * Writes eval/LIVE_RESULTS.md. Needs the API keys in .env (~15 model calls, ~25 searches).
 */
import { writeFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { config } from '../src/config.js';
import { MemoryStore } from '../src/memory/store.js';
import { createLLM } from '../src/llm/provider.js';
import { tavilySearch } from '../src/search/tavily.js';
import { runTurn, type AgentEvent } from '../src/agent/agent.js';
import { resolveTimeRefs } from '../src/time/resolve.js';
import type { Mode } from '../src/memory/types.js';

if (!config.hasLlmKey || !config.tavilyKey) {
  console.error(`eval:live needs ${config.providerKeyEnv} and TAVILY_API_KEY in .env`);
  process.exit(1);
}

const tz = config.defaultTimezone;
const now = new Date();
const at = (phrase: string, hour: number) =>
  DateTime.fromISO(resolveTimeRefs(phrase, now, tz)[0]!.range.start, { zone: tz }).set({ hour }).toJSDate();

const store = new MemoryStore(null);
const deps = { llm: createLLM(), store, search: tavilySearch };

const history = [
  { key: 'node', at: at('3 November', 11), q: 'What is the current Node.js LTS version, and when does it reach end of life?' },
  { key: 'crm', at: at('Monday', 15), q: 'We are a 20-person sales team. Shortlist 5 CRM tools for us with the per-seat monthly price of the plan we would most likely need.' },
  { key: 'postgres', at: at('last Tuesday', 10), q: 'Compare managed Postgres hosting for a small production app: Neon, Supabase, Render and AWS RDS. What does the entry paid tier cost on each?' },
].sort((a, b) => a.at.getTime() - b.at.getTime());

const probes: Array<{ q: string; mode: Mode[]; recall?: string | null; cited?: boolean; honest?: boolean }> = [
  { q: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?', mode: ['recall_verify'], recall: 'crm' },
  { q: 'What did I ask you on 3 November? Is your answer still correct today?', mode: ['recall_verify'], recall: 'node' },
  { q: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', mode: ['recall_verify'], recall: 'postgres' },
  { q: 'What did I ask you on 25 October?', mode: ['recall', 'recall_verify', 'direct'], recall: null, honest: true },
  { q: 'Who is the current CEO of OpenAI?', mode: ['search'], cited: true },
  { q: 'What changed in the latest stable Rust release?', mode: ['search'], cited: true },
  { q: 'hi!', mode: ['direct'] },
  { q: 'Explain what a B-tree index is in two sentences.', mode: ['direct'] },
];

// Free model tiers allow ~15 requests/minute and each turn makes 3–4 calls,
// so the eval paces itself. Set EVAL_PAUSE_MS=0 on a paid key.
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? 15_000);
const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));

const epKey = new Map<string, string>();
console.log(`Building history… (pausing ${PAUSE_MS / 1000}s between questions to stay under free-tier rate limits)`);
for (const h of history) {
  const r = await runTurn(deps, { message: h.q, now: h.at, timezone: tz }, () => {});
  await r.memorySaved;
  await pause();
  epKey.set(store.episodes().at(-1)!.id, h.key);
  console.log(`  ${h.key}: ${store.claimsForEpisode(store.episodes().at(-1)!.id).length} facts saved`);
}

const rows: string[] = [];
const firstTokens: number[] = [];
const routes: number[] = [];
const evidences: number[] = [];
const totals: number[] = [];
let pass = 0;
for (const p of probes) {
  const events: AgentEvent[] = [];
  await pause();
  const r = await runTurn(deps, { message: p.q, now, timezone: tz }, (e) => events.push(e));
  const plan = events.find((e) => e.type === 'plan');
  const done = events.find((e) => e.type === 'done');
  const recalled = plan?.type === 'plan' ? plan.recalled.map((x) => epKey.get(x.id) ?? 'other') : [];
  const checks: string[] = [];
  const modeOk = p.mode.includes(r.mode);
  if (!modeOk) checks.push(`mode ${r.mode}`);
  if (p.recall !== undefined) {
    const ok = p.recall === null ? recalled.length === 0 : recalled.includes(p.recall);
    if (!ok) checks.push(`recalled [${recalled.join(',')}]`);
  }
  if (p.cited && !/\[\d+\]/.test(r.answer)) checks.push('no citations');
  if (p.honest && !/no record|don't have|do not have|no conversation|nothing (stored|saved)|didn't (talk|chat)/i.test(r.answer)) checks.push('not honest about missing memory');
  const ok = checks.length === 0;
  pass += ok ? 1 : 0;
  if (done?.type === 'done') {
    if (done.timings.firstToken) firstTokens.push(done.timings.firstToken);
    totals.push(done.timings.total ?? 0);
  }
  const sec = (ms?: number) => (ms ? `${(ms / 1000).toFixed(1)}s` : '—');
  const tm = done?.type === 'done' ? done.timings : {};
  if (tm.route) routes.push(tm.route);
  if (tm.evidence && tm.route) evidences.push(tm.evidence - tm.route);
  rows.push(
    `| ${ok ? '✅' : '❌'} | ${p.q.slice(0, 80)} | ${r.mode} | ${recalled.join(', ') || '—'} | ${sec(tm.route)} | ${sec(tm.evidence && tm.route ? tm.evidence - tm.route : undefined)} | ${sec(tm.firstToken)} | ${sec(tm.total)} | ${checks.join('; ') || ''} |`,
  );
  console.log(rows.at(-1));
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(q * s.length))]! / 1000).toFixed(1) : '—';
};
const summary = [
  `Model: ${config.provider} · main ${config.mainModel} · fast ${config.fastModel}`,
  `Passed: ${pass}/${probes.length}`,
  `Planning (router): p50 ${pct(routes, 0.5)}s · Searching / re-checking: p50 ${pct(evidences, 0.5)}s`,
  `Time to first word: p50 ${pct(firstTokens, 0.5)}s · p90 ${pct(firstTokens, 0.9)}s`,
  `Full answer: p50 ${pct(totals, 0.5)}s · p90 ${pct(totals, 0.9)}s`,
];
writeFileSync(
  new URL('./LIVE_RESULTS.md', import.meta.url),
  `# Live evaluation\n\nRun on ${DateTime.now().setZone(tz).toFormat('d LLL yyyy, HH:mm')} with \`npm run eval:live\`.\n\n${summary.map((s) => `- ${s}`).join('\n')}\n\n| | Question | Path | Recalled | Plan | Search | First word | Total | Problems |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`,
);
console.log(`\n${summary.join('\n')}\nFull table → eval/LIVE_RESULTS.md`);
