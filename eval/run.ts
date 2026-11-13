/**
 * npm run eval — offline evaluation of the memory layer (no API keys).
 *
 * Measures the part of the agent that decides WHICH past conversation a
 * message refers to: date resolution + retrieval. If this is wrong, nothing
 * downstream can be right, and unlike the LLM steps it can be scored exactly.
 * Writes eval/RESULTS.md.
 */
import { writeFileSync } from 'node:fs';
import { MemoryStore } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';
import { resolveTimeRefs } from '../src/time/resolve.js';
import { CASES, NOW, TZ, seedHistory } from './cases.js';

const store = new MemoryStore(null);
const keyOf = seedHistory(store);

let top1 = 0;
let at3 = 0;
const rows: string[] = [];
const times: number[] = [];

for (const c of CASES) {
  const t = process.hrtime.bigint();
  const refs = resolveTimeRefs(c.q, NOW, TZ);
  const r = retrieve(store, c.q, refs, NOW);
  times.push(Number(process.hrtime.bigint() - t) / 1e6);

  const got = r.dateHadNoMemory ? [] : r.candidates.map((x) => keyOf.get(x.episode.id)!);
  const wantNone = c.expect.length === 0;
  const ok1 = wantNone ? got.length === 0 : c.expect.includes(got[0] ?? '');
  const ok3 = wantNone ? ok1 : got.slice(0, 3).some((k) => c.expect.includes(k));
  top1 += ok1 ? 1 : 0;
  at3 += ok3 ? 1 : 0;
  const dates = refs.map((x) => `${x.phrase} → ${x.label}`).join('; ') || '—';
  rows.push(`| ${ok1 ? '✅' : '❌'} | ${c.q.replace(/\|/g, '/')} | ${dates} | ${wantNone ? '(none)' : c.expect.join(' / ')} | ${got[0] ?? '(none)'} |`);
}

times.sort((a, b) => a - b);
const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(2);
const n = CASES.length;
const summary = [
  `Cases: ${n} questions over a 12-conversation, 3-week history`,
  `Top-1 accuracy: ${top1}/${n} (${((100 * top1) / n).toFixed(0)}%)`,
  `Recall@3: ${at3}/${n} (${((100 * at3) / n).toFixed(0)}%)`,
  `Latency (dates + retrieval): p50 ${p(0.5)} ms · p95 ${p(0.95)} ms`,
];

const md = `# Memory evaluation (offline)

Run with \`npm run eval\`. "Now" is fixed at Thu 12 Nov 2026, 22:30 IST so results are reproducible.
"(none)" cases check the agent will say it has no record instead of picking something.

${summary.map((s) => `- ${s}`).join('\n')}

| | Question | Dates resolved | Expected | Got |
|---|---|---|---|---|
${rows.join('\n')}
`;
writeFileSync(new URL('./RESULTS.md', import.meta.url), md);
console.log(summary.join('\n'));
for (const r of rows) if (r.startsWith('| ❌')) console.log(r);
console.log('\nFull table → eval/RESULTS.md');
