/**
 * npm run seed
 *
 * Creates a realistic history by running the REAL agent (real model, real
 * search) with its clock set to earlier dates. Afterwards you can ask, today:
 *   "On Monday we shortlisted 5 CRM tools… has any of them changed pricing since?"
 *   "What did I ask you on 3 November? Is your answer still correct today?"
 *   "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
 *
 * Nothing is faked: the answers and the claims ledger are what the agent
 * actually produced. Only the clock is moved.
 */
import { DateTime } from 'luxon';
import { config } from '../src/config.js';
import { MemoryStore } from '../src/memory/store.js';
import { createLLM } from '../src/llm/provider.js';
import { tavilySearch } from '../src/search/tavily.js';
import { runTurn } from '../src/agent/agent.js';
import { resolveTimeRefs } from '../src/time/resolve.js';

if (!config.hasLlmKey || !config.tavilyKey) {
  console.error(`Seed needs both ${config.providerKeyEnv} and TAVILY_API_KEY in .env`);
  process.exit(1);
}

const tz = config.defaultTimezone;
const now = new Date();
// Use the agent's own resolver so the seeded dates match how questions will be read.
const dateOf = (phrase: string, hour: number) => {
  const ref = resolveTimeRefs(phrase, now, tz)[0]!;
  return DateTime.fromISO(ref.range.start, { zone: tz }).set({ hour }).toJSDate();
};

const script = [
  {
    at: dateOf('3 November', 11),
    message: 'What is the current Node.js LTS version, and when does it reach end of life?',
  },
  {
    at: dateOf('Monday', 15),
    message:
      'We are a 20-person sales team. Shortlist 5 CRM tools for us with the per-seat monthly price of the plan we would most likely need.',
  },
  {
    at: dateOf('last Tuesday', 10),
    message:
      'Compare managed Postgres hosting for a small production app: Neon, Supabase, Render and AWS RDS. What does the entry paid tier cost on each?',
  },
].sort((a, b) => a.at.getTime() - b.at.getTime());

const store = await new MemoryStore(config.dataFile).load();
const llm = createLLM();

for (const step of script) {
  if (step.at > now) continue;
  const when = DateTime.fromJSDate(step.at, { zone: tz }).toFormat('ccc d LLL yyyy, HH:mm');
  console.log(`\n── ${when} ─────────────────────────────\n> ${step.message}\n`);
  const result = await runTurn({ llm, store, search: tavilySearch }, { message: step.message, now: step.at, timezone: tz }, (e) => {
    if (e.type === 'status') console.log(`  · ${e.text}`);
  });
  await result.memorySaved;
  const claims = store.episodes().at(-1) ? store.claimsForEpisode(store.episodes().at(-1)!.id) : [];
  console.log(`\n${result.answer.slice(0, 600)}${result.answer.length > 600 ? '…' : ''}`);
  console.log(`\n  → saved ${claims.length} fact(s) to the ledger`);
}

await store.flush();
console.log(`\nDone. Start the app with  npm run dev  and ask about Monday, last Tuesday or 3 November.\n`);
