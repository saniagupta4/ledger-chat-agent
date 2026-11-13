/**
 * The memory model. Three layers, from raw to structured:
 *
 *   Message  – the raw transcript (what was literally said)
 *   Episode  – one question/answer exchange, with a topic, entities and a date
 *   Claim    – one atomic, checkable fact the agent stated, with its source and
 *              the time it was observed. Re-checking a claim appends a new claim
 *              linked to the old one, so the ledger is a history of each fact.
 *
 * Questions like "has any pricing changed since Tuesday?" are answered by
 * diffing Claims, not by re-reading old prose.
 */

export interface Thread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Source {
  /** Citation number within one answer: [1], [2], ... */
  n: number;
  title: string;
  url: string;
  published?: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  sources?: Source[];
  /** Route the agent took for this answer (assistant messages only). */
  mode?: Mode;
}

export type Mode = 'direct' | 'search' | 'recall' | 'recall_verify';

export interface Episode {
  id: string;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  askedAt: string;
  question: string;
  /** Filled by the post-answer extraction step. */
  topic?: string;
  entities: string[];
  answerSummary?: string;
  mode: Mode;
}

export interface Claim {
  id: string;
  episodeId: string;
  /** The thing the fact is about: "HubSpot Sales Hub", "Neon", "Node.js". */
  subject: string;
  /** What about it: "Professional plan price", "latest LTS version". */
  attribute: string;
  /** The value as stated: "$100/seat/month billed annually". */
  value: string;
  sourceUrl?: string;
  /** When the fact was observed (when the agent read the source). */
  observedAt: string;
  /** 'stated' = said in an answer; 'reverified' = produced by a re-check. */
  origin: 'stated' | 'reverified';
  /** For re-checks: the claim this one re-checked. */
  previousClaimId?: string;
  /** For re-checks: did the value change? */
  status?: 'unchanged' | 'changed' | 'unverifiable';
}

export interface MemoryData {
  version: 1;
  threads: Thread[];
  messages: Message[];
  episodes: Episode[];
  claims: Claim[];
}
