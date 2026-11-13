/**
 * A fixed three-week history and questions that refer back to it, written
 * the way people actually talk ("last Tuesday", "the headphones thing",
 * "monday.com"). "Now" is Thursday 12 Nov 2026, 22:30 in India.
 */
import type { MemoryStore } from '../src/memory/store.js';

export const NOW = new Date('2026-11-12T17:00:00Z');
export const TZ = 'Asia/Kolkata';

interface Seed {
  key: string;
  at: string; // IST local time
  question: string;
  topic: string;
  entities: string[];
}

const HISTORY: Seed[] = [
  { key: 'tavily', at: '2026-10-28T12:00', question: 'Tavily vs Exa: which web search API is better for an agent?', topic: 'search API comparison', entities: ['Tavily', 'Exa'] },
  { key: 'k8s', at: '2026-10-30T16:00', question: 'What is new in Kubernetes 1.36?', topic: 'Kubernetes release', entities: ['Kubernetes'] },
  { key: 'iphone', at: '2026-11-02T10:00', question: 'When is the iPhone 18 coming out and what will it cost?', topic: 'iPhone release', entities: ['iPhone 18', 'Apple'] },
  { key: 'node', at: '2026-11-03T11:00', question: 'What is the current Node.js LTS version and when does it reach end of life?', topic: 'Node.js LTS', entities: ['Node.js'] },
  { key: 'vercel', at: '2026-11-05T14:00', question: 'Vercel or Netlify for hosting a Next.js app?', topic: 'frontend hosting', entities: ['Vercel', 'Netlify', 'Next.js'] },
  { key: 'flights', at: '2026-11-06T12:00', question: 'Cheapest flights from Delhi to Bangalore next weekend?', topic: 'flight prices', entities: ['IndiGo', 'Air India'] },
  { key: 'gemini', at: '2026-11-07T19:00', question: 'How much does the Gemini API cost per million tokens?', topic: 'Gemini API pricing', entities: ['Gemini', 'Google'] },
  { key: 'crm', at: '2026-11-09T15:00', question: 'Shortlist 5 CRM tools for our 20-person sales team with per-seat prices', topic: 'CRM shortlist', entities: ['HubSpot', 'Pipedrive', 'Salesforce', 'Zoho CRM', 'monday.com'] },
  { key: 'postgres', at: '2026-11-10T10:00', question: 'Compare managed Postgres hosting: Neon, Supabase, Render, RDS', topic: 'Postgres hosting pricing', entities: ['Neon', 'Supabase', 'Render', 'AWS RDS'] },
  { key: 'python', at: '2026-11-10T16:00', question: 'When is Python 3.15 released and what is new?', topic: 'Python release', entities: ['Python'] },
  { key: 'headphones', at: '2026-11-11T18:00', question: 'Best noise-cancelling headphones under 30k rupees?', topic: 'headphones recommendation', entities: ['Sony WH-1000XM6', 'Bose QuietComfort'] },
  { key: 'weather', at: '2026-11-12T09:00', question: 'Will it rain in Bhubaneswar this weekend?', topic: 'weather forecast', entities: ['Bhubaneswar'] },
];

/** `expect`: acceptable episode keys for the top result; [] means "no memory — must say so". */
export const CASES: Array<{ q: string; expect: string[]; note?: string }> = [
  // The three examples from the brief
  { q: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?', expect: ['crm'] },
  { q: 'What did I ask you on 3 November? Is your answer still correct today?', expect: ['node'], note: '"today" must not restrict memory to today' },
  { q: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', expect: ['postgres'], note: 'two chats that day; topic picks one' },
  // Explicit dates
  { q: 'On November 2nd I asked about the iPhone — any update?', expect: ['iphone'] },
  { q: 'what did I ask you on 28 October', expect: ['tavily'] },
  { q: 'What did we discuss on 25 October?', expect: [], note: 'no chat that day' },
  { q: 'What did I ask on Sunday?', expect: [], note: 'no chat on Sun 8 Nov' },
  // Relative days
  { q: 'What did I ask you yesterday?', expect: ['headphones'] },
  { q: 'Earlier today I asked about the weather, is it still going to rain?', expect: ['weather'] },
  { q: 'the day before yesterday I asked about a Python release', expect: ['python'] },
  { q: '3 days ago I asked about CRMs', expect: ['crm'] },
  { q: 'what did I ask you 2 days ago', expect: ['postgres', 'python'] },
  // Weekdays and ambiguity
  { q: 'Did the flight prices you found on Friday change?', expect: ['flights'] },
  { q: "Last Friday's flight search — are fares lower now?", expect: ['flights'] },
  { q: 'The Vercel vs Netlify thing from Thursday, still true?', expect: ['vercel'], note: 'Thursday said on a Thursday = a week ago' },
  { q: 'Last Tuesday I asked about the Node LTS version, is it still current?', expect: ['node'], note: 'this Tuesday was Postgres; means the Tuesday before' },
  { q: 'Last Saturday you told me Gemini API prices', expect: ['gemini'] },
  // Weeks / months
  { q: 'Last week you told me about Gemini API pricing. Did it change?', expect: ['gemini'] },
  { q: 'Remember the Kubernetes question from last month?', expect: ['k8s'] },
  { q: 'a week ago I asked about hosting a Next.js app', expect: ['vercel'] },
  // No date: topic only
  { q: 'Is monday.com still cheaper than HubSpot?', expect: ['crm'], note: '"monday" is a product here, not a day' },
  { q: 'the headphones you recommended — still the best?', expect: ['headphones'] },
  { q: 'Tell me about Neon and Supabase again', expect: ['postgres'] },
  { q: 'What about the Node version you mentioned?', expect: ['node'] },
  { q: 'Has the search API comparison changed — Exa or Tavily now?', expect: ['tavily'] },
  { q: 'Is the Python release date you gave me still right?', expect: ['python'] },
  { q: 'What did I ask you on Tuesday?', expect: ['postgres', 'python'] },
  { q: 'Is that rain forecast still on?', expect: ['weather'] },
  // Hard: paraphrases with no shared words (the known weakness of lexical retrieval)
  { q: 'the database hosting options you gave me — any cheaper now?', expect: ['postgres'], note: 'paraphrase' },
  { q: 'that sales software list we made, still valid?', expect: ['crm'], note: 'paraphrase: "sales software" ≠ "CRM"' },
  { q: 'any news on the new phone launch date?', expect: ['iphone'], note: 'paraphrase: "phone" ≠ "iPhone"' },
];

export function seedHistory(store: MemoryStore): Map<string, string> {
  const ids = new Map<string, string>();
  for (const s of HISTORY) {
    const askedAt = new Date(`${s.at}:00+05:30`).toISOString();
    const ep = store.addEpisode({
      threadId: s.key,
      userMessageId: `${s.key}-u`,
      assistantMessageId: `${s.key}-a`,
      askedAt,
      question: s.question,
      topic: s.topic,
      entities: s.entities,
      mode: 'search',
    });
    ids.set(ep.id, s.key);
  }
  return ids;
}
