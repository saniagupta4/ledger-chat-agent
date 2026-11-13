import type { Episode } from './types.js';
import type { MemoryStore } from './store.js';
import { inRange, type ResolvedRange, type TimeRef } from '../time/resolve.js';

/**
 * Finds past exchanges relevant to the current message.
 *
 * Two signals, combined:
 *  1. Time: if the message names a date ("last Tuesday"), only episodes in
 *     that range are eligible. If the primary reading has nothing, the
 *     alternate readings are tried ("last Tuesday" → the week before).
 *  2. Words: a small BM25-style lexical score over the question, topic,
 *     entities and claim subjects of each episode.
 *
 * Why not embeddings: one person's history is small, the questions name
 * concrete things (Postgres, HubSpot, "CRM"), and dates matter more than
 * semantic similarity. Lexical + time is fast, deterministic and testable.
 * Synonyms are covered because the extraction step stores entities and a
 * topic for every episode ("Neon" → topic "Postgres hosting").
 */

const STOP = new Set(
  ('a an and are as at be by did do does for from has have how i in is it its me my of on or our ' +
    'since so that the their them then there these they this to was we what when which who why will ' +
    'with you your yours any anything changed change still correct today now asked ask tell told ' +
    'last monday tuesday wednesday thursday friday saturday sunday yesterday week month ago days day ' +
    'about answer again some something new latest current currently is are were been being can could ' +
    'should would please hi hello thanks').split(' '),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [])
    .map((t) => t.replace(/[.\-]+$/, ''))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

function episodeText(store: MemoryStore, ep: Episode): string {
  const claims = store.claimsForEpisode(ep.id).map((c) => `${c.subject} ${c.attribute}`);
  return [ep.question, ep.topic ?? '', ep.entities.join(' '), ep.answerSummary ?? '', claims.join(' ')].join(' ');
}

export interface ScoredEpisode {
  episode: Episode;
  score: number;
}

/** Scores `pool` episodes; term rarity (IDF) is measured over `corpus`, so
 *  scores from different date pools are comparable. */
export function lexicalScores(
  store: MemoryStore,
  query: string,
  pool: readonly Episode[],
  corpus: readonly Episode[] = pool,
): ScoredEpisode[] {
  const q = [...new Set(tokens(query))];
  if (q.length === 0) return pool.map((episode) => ({ episode, score: 0 }));
  const docs = pool.map((ep) => new Set(tokens(episodeText(store, ep))));
  const corpusDocs = corpus === pool ? docs : corpus.map((ep) => new Set(tokens(episodeText(store, ep))));
  const N = Math.max(corpusDocs.length, 1);
  const idf = (term: string) => {
    const df = corpusDocs.filter((d) => d.has(term)).length;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  };
  return pool.map((episode, i) => {
    const d = docs[i]!;
    let score = 0;
    for (const term of q) if (d.has(term)) score += idf(term);
    return { episode, score };
  });
}

export interface Retrieval {
  candidates: ScoredEpisode[];
  /** Which date ranges were searched and which one matched. */
  searchedRanges: ResolvedRange[];
  matchedRanges: ResolvedRange[];
  /** True when the user named a date but there is no memory from it. */
  dateHadNoMemory: boolean;
}

export function retrieve(
  store: MemoryStore,
  query: string,
  timeRefs: TimeRef[],
  now: Date,
  opts: { excludeEpisodeIds?: Set<string>; limit?: number; recentFallback?: number } = {},
): Retrieval {
  const limit = opts.limit ?? 8;
  const all = store.episodes().filter((e) => !opts.excludeEpisodeIds?.has(e.id));
  const searchedRanges: ResolvedRange[] = [];
  const matchedRanges: ResolvedRange[] = [];

  // "Is it still correct today?" mentions today but is not asking about memory
  // from today. Refs covering the present only count when nothing else is named.
  const nowIso = now.toISOString();
  const pastRefs = timeRefs.filter((r) => !inRange(nowIso, r.range));
  const refs = pastRefs.length > 0 ? pastRefs : timeRefs;
  let pool: Episode[] = [];
  if (refs.length > 0) {
    for (const ref of refs) {
      // Score every reading of the phrase. The primary reading wins unless an
      // alternate is clearly a better topic match: "last Tuesday I asked about
      // Node" when this Tuesday's chats were about Postgres means the Tuesday before.
      let best: { reading: ResolvedRange; hits: Episode[]; topScore: number } | null = null;
      for (const reading of [ref as ResolvedRange, ...ref.alternates]) {
        searchedRanges.push(reading);
        const hits = all.filter((e) => inRange(e.askedAt, reading.range));
        if (hits.length === 0) continue;
        const topScore = Math.max(...lexicalScores(store, query, hits, all).map((h) => h.score));
        if (!best || topScore > best.topScore + 0.5) best = { reading, hits, topScore };
      }
      if (best) {
        matchedRanges.push(best.reading);
        pool.push(...best.hits);
      }
    }
    pool = [...new Map(pool.map((e) => [e.id, e])).values()];
  }

  const dateHadNoMemory = pastRefs.length > 0 && pool.length === 0;

  if (pool.length > 0) {
    // Date matched: keep everything from that date, ranked by relevance.
    const scored = lexicalScores(store, query, pool, all).sort(
      (a, b) => b.score - a.score || b.episode.askedAt.localeCompare(a.episode.askedAt),
    );
    return { candidates: scored.slice(0, limit), searchedRanges, matchedRanges, dateHadNoMemory };
  }

  // No date (or nothing on that date): fall back to relevance across all history.
  const scored = lexicalScores(store, query, all)
    .filter((s) => s.score >= 0.5) // at least one reasonably specific shared term
    .sort((a, b) => b.score - a.score || b.episode.askedAt.localeCompare(a.episode.askedAt))
    .slice(0, Math.min(limit, 5));

  // Lexical matching misses paraphrases ("the sales software" vs "CRM"). The
  // most recent few conversations are always shown to the router too, so the
  // LLM can make the semantic match on a small, cheap candidate set.
  const recent = [...all]
    .sort((a, b) => b.askedAt.localeCompare(a.askedAt))
    .filter((e) => !scored.some((s) => s.episode.id === e.id))
    .slice(0, opts.recentFallback ?? 3)
    .map((episode) => ({ episode, score: 0 }));
  return { candidates: [...scored, ...recent], searchedRanges, matchedRanges, dateHadNoMemory };
}
