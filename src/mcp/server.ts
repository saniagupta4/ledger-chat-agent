import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '../memory/store.js';
import type { Claim } from '../memory/types.js';
import { retrieve } from '../memory/retrieve.js';
import { formatLocal, resolveTimeRefs } from '../time/resolve.js';

/**
 * The agent's memory, exposed over MCP (Model Context Protocol).
 *
 * Any MCP client (Claude Desktop, Claude Code, Cursor…) can ask:
 *   - what did I research on <date>?            → recall_conversations
 *   - how has <thing> changed over time?        → fact_history
 *   - which facts I was told may be outdated?   → stale_facts
 *
 * Read-only on purpose: the chat server is the single writer of the memory
 * file, so two processes can never overwrite each other's changes.
 * The file is re-read on every call, so answers include the latest chats.
 */

export interface McpDeps {
  loadStore: () => Promise<MemoryStore>;
  now: () => Date;
  timezone: string;
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/** Follow the re-check links from an original claim to its newest version. */
function lineage(store: MemoryStore, root: Claim): Claim[] {
  const chain = [root];
  for (;;) {
    const last = chain[chain.length - 1]!;
    const next = store
      .allClaims()
      .filter((c) => c.previousClaimId === last.id)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt))[0];
    if (!next) return chain;
    chain.push(next);
  }
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'ledger-memory', version: '1.0.0' });
  const tz = deps.timezone;

  server.registerTool(
    'recall_conversations',
    {
      title: 'Recall past conversations',
      description:
        'Find what the user asked the research agent and what it answered, optionally on a date. ' +
        'Accepts natural date phrases like "last Tuesday", "3 November", "yesterday".',
      inputSchema: {
        query: z.string().describe('What the conversation was about, e.g. "Postgres hosting". Can be empty.'),
        when: z.string().optional().describe('Optional date phrase, e.g. "last Tuesday" or "on 3 November".'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, when }) => {
      const store = await deps.loadStore();
      const now = deps.now();
      const refs = when ? resolveTimeRefs(when, now, tz) : [];
      const r = retrieve(store, query, refs, now, { limit: 6 });
      const header = refs.length
        ? `Date resolved: ${refs.map((x) => `"${x.phrase}" = ${x.label}`).join(', ')}${r.matchedRanges.length && r.matchedRanges[0]!.label !== refs[0]!.label ? ` (nothing then; used ${r.matchedRanges[0]!.label})` : ''}\n`
        : '';
      if (r.dateHadNoMemory) {
        return text(`${header}No stored conversations on ${refs.map((x) => x.label).join(' / ')}.`);
      }
      if (r.candidates.length === 0) {
        return text(`${header}No stored conversations match${when ? ` on ${refs[0]?.label ?? when}` : ''}.`);
      }
      const body = r.candidates
        .map(({ episode: e }) => {
          const claims = store.claimsForEpisode(e.id).map((c) => `  - ${c.subject} · ${c.attribute}: ${c.value}`);
          return [
            `• ${formatLocal(e.askedAt, tz, 'ccc d LLL yyyy, HH:mm')} — asked: "${e.question}"`,
            e.answerSummary ? `  answer: ${e.answerSummary}` : '',
            ...claims,
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n');
      return text(header + body);
    },
  );

  server.registerTool(
    'fact_history',
    {
      title: 'History of a fact',
      description:
        'Every value the agent has reported for a subject (e.g. "Neon", "HubSpot"), with dates, sources and ' +
        'whether later re-checks found it unchanged or changed.',
      inputSchema: { subject: z.string().describe('Product, company or topic name.') },
      annotations: { readOnlyHint: true },
    },
    async ({ subject }) => {
      const store = await deps.loadStore();
      const needle = subject.toLowerCase();
      const roots = store
        .allClaims()
        .filter((c) => !c.previousClaimId && c.subject.toLowerCase().includes(needle));
      if (roots.length === 0) return text(`No facts stored about "${subject}".`);
      const out = roots.map((root) => {
        const steps = lineage(store, root).map((c) => {
          const when = formatLocal(c.observedAt, tz, 'd LLL yyyy');
          const tag = c.origin === 'stated' ? 'stated' : `re-check: ${c.status}`;
          return `  ${when} · ${c.value} (${tag}${c.sourceUrl ? `, ${c.sourceUrl}` : ''})`;
        });
        return `${root.subject} — ${root.attribute}\n${steps.join('\n')}`;
      });
      return text(out.join('\n\n'));
    },
  );

  server.registerTool(
    'stale_facts',
    {
      title: 'Facts that may be out of date',
      description:
        'Facts the agent told the user that have not been re-checked for N days: prices, versions, plans. ' +
        'Useful to decide what to verify again.',
      inputSchema: { olderThanDays: z.number().int().min(0).default(7) },
      annotations: { readOnlyHint: true },
    },
    async ({ olderThanDays }) => {
      const store = await deps.loadStore();
      const cutoff = deps.now().getTime() - olderThanDays * 86_400_000;
      const latest = store
        .allClaims()
        .filter((c) => !c.previousClaimId)
        .map((c) => store.latestVersion(c))
        .filter((c) => Date.parse(c.observedAt) <= cutoff)
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      if (latest.length === 0) return text(`Nothing older than ${olderThanDays} days. Every stored fact is recent.`);
      return text(
        latest
          .map((c) => `• ${c.subject} · ${c.attribute}: ${c.value} — last checked ${formatLocal(c.observedAt, tz, 'd LLL yyyy')}`)
          .join('\n'),
      );
    },
  );

  return server;
}
