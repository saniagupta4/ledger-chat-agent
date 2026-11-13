import { z } from 'zod';
import type { LLM } from '../llm/types.js';
import type { Episode, Message, Mode } from '../memory/types.js';
import type { TimeRef } from '../time/resolve.js';
import { describeNow, formatLocal } from '../time/resolve.js';

/**
 * The router decides, before any expensive work, which of four paths a turn
 * takes. One structured call to the FAST model (~0.3–1 s):
 *
 *   direct        – no search needed (greetings, stable knowledge, follow-ups
 *                   answerable from the conversation). Fastest path.
 *   search        – current facts: run 1–4 queries IN PARALLEL up front.
 *   recall        – "what did I ask you on 3 Nov?" – memory only.
 *   recall_verify – "…is it still correct?" / "has anything changed since?"
 *                   – memory + re-check every stored claim.
 *
 * Planning the queries up front (instead of letting the answer model call
 * search one query at a time) is the biggest latency win: N searches cost
 * the time of one.
 */

export const planSchema = z.object({
  mode: z.enum(['direct', 'search', 'recall', 'recall_verify']),
  episodeIds: z
    .array(z.string())
    .describe('IDs of MEMORY CANDIDATES the user is referring to. Empty if none.'),
  searches: z
    .array(
      z.object({
        query: z.string(),
        recentOnly: z.boolean().describe('true = news / last month only'),
      }),
    )
    .describe('0–4 web searches to run in parallel before answering.'),
  reason: z.string().describe('One short sentence explaining the choice.'),
});

export type Plan = z.infer<typeof planSchema>;

const SYSTEM = `You are the planning step of a chat agent that has web search and a long-term memory of past conversations with this user.
Decide how to handle the user's latest message. Output JSON only.

Modes:
- "direct": greetings, thanks, chit-chat, questions about yourself, stable knowledge that cannot have changed (definitions, maths, how something works, writing/coding help), or follow-ups fully answerable from the conversation so far.
- "search": anything that can change or that you might not know: prices, plans, releases, news, versions, who holds a role, rankings, "best X", events, statistics, anything after your training data, specific products/companies/people. When unsure between direct and search, choose search.
- "recall": the user asks what was said or asked in an earlier conversation, and does NOT ask whether it is still true.
- "recall_verify": the user refers to an earlier conversation AND asks whether it is still correct, whether something changed/was updated/shipped since, or for the latest on it.

Rules:
- episodeIds: choose from MEMORY CANDIDATES only. Pick the ones the user means; a date match plus topic match is strong evidence. If the user refers to an earlier conversation but no candidate fits, return [] (the agent will say it has no record).
- searches: for "search" mode, 1–4 specific queries covering DIFFERENT aspects (e.g. one per product being compared). Include the current year when recency matters. Do not add searches for "recall_verify" unless the user also asks something new the old answer did not cover — re-checking old facts is done automatically.
- The current date is given; never assume an older date.`;

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function buildRouterPrompt(args: {
  message: string;
  now: Date;
  timezone: string;
  timeRefs: TimeRef[];
  candidates: Episode[];
  dateHadNoMemory: boolean;
  recent: Message[];
}): string {
  const lines: string[] = [];
  lines.push(`NOW: ${describeNow(args.now, args.timezone)}`);
  if (args.timeRefs.length) {
    lines.push('DATES IN MESSAGE (resolved by code, trust these):');
    for (const r of args.timeRefs) lines.push(`- "${r.phrase}" = ${r.label}`);
    if (args.dateHadNoMemory) lines.push('(No conversations are stored from those dates.)');
  }
  lines.push('MEMORY CANDIDATES:');
  if (args.candidates.length === 0) lines.push('(none)');
  for (const e of args.candidates) {
    lines.push(
      `- id=${e.id} | ${formatLocal(e.askedAt, args.timezone)} | asked: "${truncate(e.question, 200)}"` +
        (e.topic ? ` | topic: ${e.topic}` : ''),
    );
  }
  if (args.recent.length) {
    lines.push('CURRENT CONVERSATION (latest last):');
    for (const m of args.recent) lines.push(`${m.role}: ${truncate(m.content, 400)}`);
  }
  lines.push(`USER MESSAGE: ${args.message}`);
  return lines.join('\n');
}

const GREETING = /^(hi|hey|hello|yo|thanks|thank you|thx|ok|okay|cool|great|bye|good (morning|night|evening))\b[\s!.,]*$/i;
const CHANGE_CUE = /\b(still|changed?|since|update[sd]?|latest|now|today|anymore|correct|accurate|true|new)\b/i;
const RECALL_CUE = /\b(i asked|did i ask|you (said|told|recommended|suggested)|we (talked|discussed|shortlisted|compared|looked)|last time|earlier|before|previous(ly)?)\b/i;

/** Rule-based plan: used for trivial messages (skip the LLM) and if the router call fails. */
export function heuristicPlan(message: string, candidates: Episode[], hasTimeRef: boolean): Plan {
  if (GREETING.test(message.trim())) {
    return { mode: 'direct', episodeIds: [], searches: [], reason: 'greeting' };
  }
  const refersBack = RECALL_CUE.test(message) || (hasTimeRef && candidates.length > 0);
  if (refersBack) {
    return {
      mode: CHANGE_CUE.test(message) ? 'recall_verify' : 'recall',
      episodeIds: candidates.slice(0, 3).map((c) => c.id),
      searches: [],
      reason: 'heuristic: refers to an earlier conversation',
    };
  }
  return { mode: 'search', episodeIds: [], searches: [{ query: message.slice(0, 200), recentOnly: false }], reason: 'heuristic: default to search' };
}

export function isTrivial(message: string): boolean {
  return GREETING.test(message.trim());
}

export async function route(
  llm: LLM,
  args: Parameters<typeof buildRouterPrompt>[0],
): Promise<{ plan: Plan; fallback: boolean }> {
  if (isTrivial(args.message)) {
    return { plan: heuristicPlan(args.message, [], false), fallback: false };
  }
  try {
    const plan = await llm.structured({
      tier: 'fast',
      schema: planSchema,
      system: SYSTEM,
      prompt: buildRouterPrompt(args),
      timeoutMs: 12_000,
    });
    // Guard against hallucinated IDs and over-planning.
    const valid = new Set(args.candidates.map((c) => c.id));
    plan.episodeIds = plan.episodeIds.filter((id) => valid.has(id));
    plan.searches = plan.searches.filter((s) => s.query.trim()).slice(0, 4);
    if (plan.mode === 'search' && plan.searches.length === 0) {
      plan.searches = [{ query: args.message.slice(0, 200), recentOnly: false }];
    }
    return { plan, fallback: false };
  } catch (err) {
    console.warn(`[router] planning call failed, using rule-based plan: ${(err as Error).message}`);
    return {
      plan: heuristicPlan(args.message, args.candidates, args.timeRefs.length > 0),
      fallback: true,
    };
  }
}

export type { Mode };
