import type { LLM, StreamRequest, StructuredRequest } from '../src/llm/types.js';
import type { SearchFn, SearchOptions } from '../src/search/tavily.js';

/**
 * Scripted stand-ins for the model and search API, so the full pipeline
 * (dates → memory → route → verify → answer → extract) runs in tests with
 * no keys and no network. Each structured call is recognised by its system
 * prompt and answered by a small, deterministic rule.
 */

export interface FakeCalls {
  structured: Array<{ system: string; prompt: string }>;
  streams: StreamRequest[];
  searches: Array<{ query: string; opts?: SearchOptions }>;
}

export function fakeLLM(script: { answer: (req: StreamRequest) => string }, calls: FakeCalls): LLM {
  return {
    async structured<T>(req: StructuredRequest<T>): Promise<T> {
      calls.structured.push({ system: req.system, prompt: req.prompt });

      if (req.system.includes('planning step')) {
        const ids = [...req.prompt.matchAll(/id=(\w+)/g)].map((m) => m[1]!);
        const msg = req.prompt.split('USER MESSAGE: ')[1] ?? '';
        const refersBack = /\b(asked|we shortlisted|you told)\b/i.test(msg);
        const change = /\b(changed?|still|since)\b/i.test(msg);
        const mode = refersBack ? (change ? 'recall_verify' : 'recall') : 'search';
        return req.schema.parse({
          mode,
          episodeIds: refersBack ? ids : [],
          searches: mode === 'search' ? [{ query: msg, recentOnly: false }] : [],
          reason: 'fake router',
        });
      }

      if (req.system.includes('compare facts')) {
        // Claim ids from the prompt; current price = first "$N" in the evidence.
        const claimIds = [...req.prompt.matchAll(/claimId=(\S+)/g)].map((m) => m[1]!);
        const evidence = req.prompt.split('NEW EVIDENCE:')[1] ?? '';
        const price = evidence.match(/\$\d+/)?.[0] ?? '';
        const old = req.prompt.match(/: (\$\d+)/)?.[1] ?? '';
        return req.schema.parse({
          checks: claimIds.map((claimId) => ({
            claimId,
            status: !price ? 'unverifiable' : price === old ? 'unchanged' : 'changed',
            currentValue: price ? `${price}/month` : '',
            sources: price ? [1] : [],
            note: price && price !== old ? `${old} → ${price}` : '',
          })),
          developments: [],
        });
      }

      if (req.system.includes('structured memory')) {
        const answer = req.prompt.split('ASSISTANT ANSWERED:\n')[1] ?? '';
        const price = answer.match(/\$\d+\/month/)?.[0];
        return req.schema.parse({
          topic: 'Postgres hosting pricing',
          entities: ['Neon'],
          summary: 'User asked about Neon pricing.',
          claims: price ? [{ subject: 'Neon', attribute: 'Launch plan price', value: price, sourceNumber: 1 }] : [],
        });
      }
      throw new Error(`unexpected structured call: ${req.system.slice(0, 60)}`);
    },

    async *stream(req: StreamRequest) {
      calls.streams.push(req);
      const text = script.answer(req);
      for (const word of text.split(/(?<= )/)) yield word;
    },
  };
}

/** A tiny web whose contents the test can change between "days". */
export function fakeSearch(world: { neonPrice: string }, calls: FakeCalls): SearchFn {
  return async (query, opts) => {
    calls.searches.push({ query, opts });
    if (opts?.topic === 'news') return { query, results: [], ms: 1 };
    return {
      query,
      ms: 1,
      results: [
        {
          title: 'Neon pricing',
          url: 'https://neon.com/pricing',
          content: `Launch plan: ${world.neonPrice}/month. Scale plan: $69/month.`,
          published: '2026-11-01',
        },
      ],
    };
  };
}

export function newCalls(): FakeCalls {
  return { structured: [], streams: [], searches: [] };
}
