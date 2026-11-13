import { config } from '../config.js';

/**
 * The agent's one tool: web search (Tavily).
 *
 * Tavily returns cleaned page content with each result, so one call gives
 * the model enough text to answer from. No second "fetch the page" round
 * trip, which is the main latency cost in most search agents.
 *
 * - 10-minute in-memory cache: follow-ups re-asking the same query are instant.
 * - 8 s timeout per call: one slow query cannot stall the whole answer.
 * - Failures return [] plus an error string; the agent says it could not
 *   check, rather than crashing or inventing.
 */

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  published?: string;
  score?: number;
}

export interface SearchOptions {
  /** 'news' biases to recent articles; 'general' to reference pages. */
  topic?: 'general' | 'news';
  /** Restrict to recent results. */
  timeRange?: 'day' | 'week' | 'month' | 'year';
  maxResults?: number;
  depth?: 'basic' | 'advanced';
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  error?: string;
  cached?: boolean;
  ms: number;
}

export type SearchFn = (query: string, opts?: SearchOptions) => Promise<SearchResponse>;

const cache = new Map<string, { at: number; value: SearchResponse }>();
const TTL_MS = 10 * 60 * 1000;

export const tavilySearch: SearchFn = async (query, opts = {}) => {
  const started = Date.now();
  if (!config.tavilyKey) {
    return { query, results: [], error: 'TAVILY_API_KEY is not set', ms: 0 };
  }
  const key = JSON.stringify([query.toLowerCase().trim(), opts]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true, ms: 0 };

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.tavilyKey}` },
      body: JSON.stringify({
        query,
        topic: opts.topic ?? 'general',
        search_depth: opts.depth ?? 'basic',
        max_results: opts.maxResults ?? 5,
        include_answer: false,
        include_raw_content: false,
        ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { query, results: [], error: `search failed (${res.status}) ${body.slice(0, 200)}`, ms: Date.now() - started };
    }
    const json = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string; score?: number }>;
    };
    const value: SearchResponse = {
      query,
      results: (json.results ?? [])
        .filter((r) => r.url)
        .map((r) => ({
          title: r.title ?? r.url!,
          url: r.url!,
          content: (r.content ?? '').slice(0, 1800),
          published: r.published_date,
          score: r.score,
        })),
      ms: Date.now() - started,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    return { query, results: [], error: `search error: ${(err as Error).message}`, ms: Date.now() - started };
  }
};

/** Small concurrency limiter so a fan-out of 12 searches doesn't hit rate limits. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
