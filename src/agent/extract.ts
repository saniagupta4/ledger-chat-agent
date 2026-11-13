import { z } from 'zod';
import type { LLM } from '../llm/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { Mode, Source } from '../memory/types.js';

/**
 * After an answer has been streamed, the FAST model turns it into memory:
 * a topic, entities, a one-line summary and the atomic checkable claims.
 *
 * Runs after the response is sent (off the latency path). If it fails, the
 * episode still exists with the raw question and answer, so "what did I ask
 * on 3 Nov" keeps working; only the structured re-check gets weaker.
 */

const extractionSchema = z.object({
  topic: z.string().describe('3–6 words, e.g. "Postgres hosting pricing"'),
  entities: z.array(z.string()).describe('Products, companies, people, technologies the exchange is about (max 8).'),
  summary: z.string().describe('One or two sentences: what the user wanted and what the answer concluded.'),
  claims: z
    .array(
      z.object({
        subject: z.string().describe('The specific thing, e.g. "Neon", "HubSpot Sales Hub Professional"'),
        attribute: z.string().describe('What about it, e.g. "Launch plan price", "free tier storage"'),
        value: z.string().describe('The value as stated in the answer, with units and billing terms'),
        sourceNumber: z.number().nullable().describe('The [n] citation supporting it, or null'),
      }),
    )
    .describe('Checkable facts from the ANSWER that could change over time (max 15). Empty if none.'),
});

const SYSTEM = `You turn one chat exchange into structured memory.
Claims: only facts the ASSISTANT stated that could change over time and can be checked on the web: prices, plan limits, versions, release dates, features, who holds a role, availability, rankings, statistics.
Skip opinions, advice, stable facts (definitions, history) and anything hedged as unknown.
Each claim must be atomic (one subject, one attribute, one value) and use the exact value from the answer.`;

export async function extractMemory(args: {
  llm: LLM;
  store: MemoryStore;
  episodeId: string;
  question: string;
  answer: string;
  sources: Source[];
  mode: Mode;
  observedAt: string;
}): Promise<void> {
  const { llm, store } = args;
  const sourceList = args.sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join('\n');
  const result = await llm.structured({
    tier: 'fast',
    schema: extractionSchema,
    system: SYSTEM,
    prompt: `USER ASKED:\n${args.question}\n\nASSISTANT ANSWERED:\n${args.answer.slice(0, 8000)}\n\nSOURCES:\n${sourceList || '(none)'}`,
    timeoutMs: 25_000,
  });

  store.updateEpisode(args.episodeId, {
    topic: result.topic,
    entities: result.entities.slice(0, 8),
    answerSummary: result.summary,
  });

  // In recall_verify turns the verifier already appended re-checked claims;
  // extracting again from the answer would duplicate them.
  if (args.mode === 'recall_verify' || args.mode === 'recall') return;

  const urlByN = new Map(args.sources.map((s) => [s.n, s.url]));
  store.addClaims(
    result.claims.slice(0, 15).map((c) => ({
      episodeId: args.episodeId,
      subject: c.subject,
      attribute: c.attribute,
      value: c.value,
      sourceUrl: c.sourceNumber != null ? urlByN.get(c.sourceNumber) : undefined,
      observedAt: args.observedAt,
      origin: 'stated' as const,
    })),
  );
}
