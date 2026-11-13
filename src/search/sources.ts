import type { Source } from '../memory/types.js';
import type { SearchResult } from './tavily.js';

/**
 * Numbers every page the agent reads during one turn, so the answer can cite
 * [1], [2] … and the UI can show the same numbered list. A URL seen twice
 * (e.g. by the router's search and again by a follow-up tool call) keeps
 * its first number.
 */
export class SourceBook {
  private byUrl = new Map<string, Source & { content: string }>();

  add(r: SearchResult): number {
    const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '');
    const existing = this.byUrl.get(key);
    if (existing) return existing.n;
    const n = this.byUrl.size + 1;
    this.byUrl.set(key, { n, title: r.title, url: r.url, published: r.published, content: r.content });
    return n;
  }

  /** Text block for the model: numbered results with dates and content. */
  format(results: SearchResult[], maxChars = 1800): string {
    if (results.length === 0) return '(no results)';
    return results
      .map((r) => {
        const n = this.add(r);
        const date = r.published ? ` (published ${r.published})` : '';
        return `[${n}] ${r.title}${date}\nURL: ${r.url}\n${r.content.slice(0, maxChars)}`;
      })
      .join('\n\n');
  }

  /** Compact numbered list (no page text) for prompts that only need to cite. */
  index(): string {
    return this.list()
      .map((s) => `[${s.n}] ${s.title}${s.published ? ` (published ${s.published})` : ''} — ${s.url}`)
      .join('\n');
  }

  list(): Source[] {
    return [...this.byUrl.values()].map(({ content: _c, ...s }) => s);
  }

  /** Only the sources the answer actually cited, in citation order. */
  cited(answer: string): Source[] {
    // Accept [1], [1][2] and grouped forms like [2, 3] that models also write.
    const used = new Set(
      [...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1]!.split(',').map((n) => Number(n.trim()))),
    );
    return this.list().filter((s) => used.has(s.n));
  }
}
