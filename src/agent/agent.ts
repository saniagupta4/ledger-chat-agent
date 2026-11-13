import type { LLM, ChatMessage } from '../llm/types.js';
import type { MemoryStore } from '../memory/store.js';
import type { Episode, Mode, Source } from '../memory/types.js';
import { retrieve } from '../memory/retrieve.js';
import type { SearchFn, SearchResponse } from '../search/tavily.js';
import { SourceBook } from '../search/sources.js';
import { resolveTimeRefs, formatLocal } from '../time/resolve.js';
import { route } from './router.js';
import { formatReport, verifyEpisodes, type VerificationReport } from './verify.js';
import { buildAnswerSystem, memoryBlock } from './prompts.js';
import { extractMemory } from './extract.js';

/**
 * One turn of the agent:
 *
 *   resolve dates (code) → retrieve memory (code) → route (fast LLM)
 *     → [parallel] planned searches + claim re-verification
 *     → stream the answer (main LLM, may do ≤2 extra searches)
 *     → save, then extract claims in the background (fast LLM)
 *
 * Everything before "stream the answer" is designed to finish in ~1–4 s,
 * and the UI shows each stage as it happens so the wait is never silent.
 */

export type AgentEvent =
  | { type: 'thread'; threadId: string; title: string }
  | { type: 'status'; stage: string; text: string }
  | {
      type: 'plan';
      mode: Mode;
      reason: string;
      searches: string[];
      timeRefs: Array<{ phrase: string; label: string }>;
      recalled: Array<{ id: string; when: string; question: string }>;
    }
  | { type: 'verification'; report: PublicReport }
  | { type: 'token'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'done'; threadId: string; messageId: string; mode: Mode; timings: Record<string, number> }
  | { type: 'error'; message: string };

export interface PublicReport {
  since: string;
  checks: Array<{ subject: string; attribute: string; was: string; now: string; status: string }>;
  developments: Array<{ subject: string; what: string; date: string }>;
}

export interface AgentDeps {
  llm: LLM;
  store: MemoryStore;
  search: SearchFn;
}

export interface TurnInput {
  threadId?: string;
  message: string;
  now: Date;
  timezone: string;
  signal?: AbortSignal;
}

export interface TurnResult {
  threadId: string;
  messageId: string;
  answer: string;
  mode: Mode;
  /** Resolves when background memory extraction finishes (awaited by tests/seed). */
  memorySaved: Promise<void>;
}

const HISTORY_TURNS = 8;

function toPublic(r: VerificationReport): PublicReport {
  return {
    since: r.since,
    checks: r.checks.map((c) => ({
      subject: c.claim.subject,
      attribute: c.claim.attribute,
      was: c.claim.value,
      now: c.status === 'changed' ? c.currentValue : c.status === 'unchanged' ? c.claim.value : '',
      status: c.status,
    })),
    developments: r.developments.map(({ subject, what, date }) => ({ subject, what, date })),
  };
}

export async function runTurn(deps: AgentDeps, input: TurnInput, emit: (e: AgentEvent) => void): Promise<TurnResult> {
  const { llm, store, search } = deps;
  const { now, timezone, message } = input;
  const nowIso = now.toISOString();
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string) => (timings[k] = Date.now() - t0);

  // ---- thread ---------------------------------------------------------------
  let thread = input.threadId ? store.getThread(input.threadId) : undefined;
  if (!thread) {
    thread = store.createThread(message.replace(/\s+/g, ' ').trim(), nowIso);
    emit({ type: 'thread', threadId: thread.id, title: thread.title });
  }
  const recent = store.threadMessages(thread.id).slice(-HISTORY_TURNS);

  // ---- dates + memory (deterministic, ~1 ms) --------------------------------
  const timeRefs = resolveTimeRefs(message, now, timezone);
  const retrieval = retrieve(store, message, timeRefs, now);
  mark('retrieve');

  // ---- route ----------------------------------------------------------------
  emit({ type: 'status', stage: 'route', text: 'Planning' });
  const { plan } = await route(llm, {
    message,
    now,
    timezone,
    timeRefs,
    candidates: retrieval.candidates.map((c) => c.episode),
    dateHadNoMemory: retrieval.dateHadNoMemory,
    recent,
  });
  mark('route');

  const recalled = plan.episodeIds
    .map((id) => store.getEpisode(id))
    .filter((e): e is Episode => Boolean(e))
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt));

  emit({
    type: 'plan',
    mode: plan.mode,
    reason: plan.reason,
    searches: plan.searches.map((s) => s.query),
    timeRefs: timeRefs.map((r) => ({ phrase: r.phrase, label: r.label })),
    recalled: recalled.map((e) => ({ id: e.id, when: formatLocal(e.askedAt, timezone), question: e.question })),
  });

  // Save the user's message and open this turn's episode now, so re-verified
  // claims can be attached to it.
  const userMsg = store.addMessage({ threadId: thread.id, role: 'user', content: message, createdAt: nowIso });
  const episode = store.addEpisode({
    threadId: thread.id,
    userMessageId: userMsg.id,
    assistantMessageId: '',
    askedAt: nowIso,
    question: message,
    entities: [],
    mode: plan.mode,
  });

  // ---- evidence: planned searches ‖ re-verification --------------------------
  const book = new SourceBook();
  const searchTask: Promise<SearchResponse[]> = plan.searches.length
    ? (emit({ type: 'status', stage: 'search', text: `Searching: ${plan.searches.map((s) => s.query).join(' · ')}` }),
      Promise.all(
        plan.searches.map((s) =>
          search(s.query, s.recentOnly ? { topic: 'news', timeRange: 'month', maxResults: 5 } : { maxResults: 5 }),
        ),
      ))
    : Promise.resolve([]);

  const verifyTask: Promise<VerificationReport | null> =
    plan.mode === 'recall_verify' && recalled.length > 0
      ? verifyEpisodes({
          llm,
          store,
          search,
          book,
          episodes: recalled,
          now,
          timezone,
          currentEpisodeId: episode.id,
          onProgress: (text) => emit({ type: 'status', stage: 'verify', text }),
        })
      : Promise.resolve(null);

  if (plan.mode === 'recall' && recalled.length > 0) {
    emit({ type: 'status', stage: 'recall', text: `Found ${recalled.length} earlier conversation${recalled.length > 1 ? 's' : ''}` });
  }

  const [searchResponses, report] = await Promise.all([searchTask, verifyTask]);
  mark('evidence');
  if (report) emit({ type: 'verification', report: toPublic(report) });

  const evidence = searchResponses
    .map((r) => `### Search: "${r.query}"${r.error ? ` — FAILED: ${r.error}` : ''}\n${book.format(r.results)}`)
    .join('\n\n');

  // ---- answer -----------------------------------------------------------------
  const system = buildAnswerSystem({
    now,
    timezone,
    mode: plan.mode,
    timeRefs,
    dateHadNoMemory: retrieval.dateHadNoMemory && recalled.length === 0,
    memory: memoryBlock(store, recalled, timezone),
    verification: report ? `${formatReport(report, timezone)}\n\nSources:\n${book.index()}` : '',
    evidence,
  });

  const history: ChatMessage[] = recent.map((m) => ({
    role: m.role,
    content: m.content.length > 2500 ? `${m.content.slice(0, 2500)}…` : m.content,
  }));
  history.push({ role: 'user', content: message });

  emit({ type: 'status', stage: 'answer', text: 'Writing' });
  let answer = '';
  try {
    for await (const chunk of llm.stream({
      system,
      messages: history,
      maxToolSteps: 2,
      signal: input.signal,
      webSearch: async (query, recentOnly) => {
        emit({ type: 'status', stage: 'search', text: `Searching: ${query}` });
        const r = await search(query, recentOnly ? { topic: 'news', timeRange: 'month' } : {});
        return r.error ? `Search failed: ${r.error}` : book.format(r.results);
      },
    })) {
      if (!timings.firstToken) mark('firstToken');
      answer += chunk;
      emit({ type: 'token', text: chunk });
    }
  } catch (err) {
    const msg = (err as Error).message || 'model error';
    console.error('[answer] model call failed:', err);
    emit({ type: 'error', message: `The model call failed: ${msg}` });
    if (!answer) answer = `_(No answer — the model call failed: ${msg})_`;
  }
  mark('total');

  // ---- save -------------------------------------------------------------------
  const sources = book.cited(answer);
  const assistantMsg = store.addMessage({
    threadId: thread.id,
    role: 'assistant',
    content: answer,
    createdAt: new Date(now.getTime() + (Date.now() - t0)).toISOString(),
    sources,
    mode: plan.mode,
  });
  store.updateEpisode(episode.id, { assistantMessageId: assistantMsg.id });
  emit({ type: 'sources', sources });
  emit({ type: 'done', threadId: thread.id, messageId: assistantMsg.id, mode: plan.mode, timings });

  // Off the latency path: structure this exchange into episode + claims.
  const memorySaved = extractMemory({
    llm,
    store,
    episodeId: episode.id,
    question: message,
    answer,
    sources: book.list(),
    mode: plan.mode,
    observedAt: nowIso,
  }).catch((err) => {
    console.warn(`[memory] extraction failed for episode ${episode.id}: ${(err as Error).message}`);
  });

  return { threadId: thread.id, messageId: assistantMsg.id, answer, mode: plan.mode, memorySaved };
}
