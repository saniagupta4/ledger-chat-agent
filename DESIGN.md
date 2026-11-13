# DESIGN

## The problem behind the brief

The sample questions ("On Monday we shortlisted… changed since?", "What did I ask on 3 November? Still correct?") are not search questions. Each one needs memory across sessions, correct date arithmetic, an exact record of **what the agent claimed**, and a way to re-check those claims today. So the agent is built around a **claims ledger**: search is the tool, and the ledger is the architecture.

## How it works

```
message → resolve dates (code) → retrieve memory (code) → route (fast LLM, 1 structured call)
                                   direct | search | recall | recall_verify
        → in parallel: planned searches (1–4) ‖ re-check of stored claims
        → stream answer (main LLM, cites [n], ≤2 extra searches)
        → background: extract topic, entities, atomic claims → ledger (also served over MCP)
```

- **Memory has three layers**: messages; *episodes* (one Q&A, with date, topic, entities); and *claims*, atomic facts like `Neon · Launch price · $19/mo · source · observed 10 Nov`. A re-check never edits a claim. It appends a new one linked to the old, so each fact has a history, and "has anything changed?" becomes a diff, not the model re-reading old prose.
- **Dates are resolved in code**, in the user's timezone. "Last Tuesday" said on a Thursday has two readings; both are kept, and retrieval keeps the one whose conversations match the topic. `monday.com` is not a Monday.
- **Re-verification** fans out a fact query and a news-since query per subject, in parallel. One structured call then labels each claim *unchanged*, *changed* (old → new) or *unverifiable*. Nothing is silently dropped.
- **Honesty**: if the user names a date with no conversation, the agent says it has no record instead of inventing one. Answers separate "what I told you on 10 Nov" from "checked just now".
- **MCP server** (`npm run mcp`): the ledger as read-only tools (`recall_conversations`, `fact_history`, `stale_facts`) for Claude Desktop or any MCP client. Read-only keeps the chat server the single writer.

## Fast and robust

All searches, including the re-check fan-out, run in parallel, so N searches cost one round trip. Trivial messages skip the router, and stable-knowledge questions skip search. Tavily returns page content, so there is no fetch-the-page hop; results are cached for 10 minutes and each call has an 8 s timeout. Memory extraction happens after the answer has streamed.
If the main model is overloaded, silent for 6 s or unavailable, the turn fails over to the fast model, and a circuit breaker skips the main model for 5 minutes. If a network buffers streaming, the answer falls back to a normal request. On a rate limit with a short "retry in N s", it waits once. Errors always reach the UI. `npm run doctor` diagnoses keys, models and search.

## Evidence

- `npm test`: 28 tests, no keys. They cover the full pipeline against a scripted model and a fake web whose prices change between "days", plus dates, MCP and model-failure handling (overload, stalls, rate limits).
- `npm run eval`: memory retrieval on 31 realistic questions, **30/31 top-1, about 0.4 ms**. It caught a real bug: "last Tuesday… Node" chose this Tuesday's Postgres chat, which is why readings are now scored by topic. The remaining miss is a pure paraphrase ("the new phone" vs "iPhone").
- `npm run eval:live`: real model and search, **8/8** on the brief's three questions, a date with no memory, fresh searches and chit-chat. Time to first word: about 2 s for chat, 4–9 s for web questions, and 7–15 s for a full re-check of 3–10 stored facts (free-tier Gemini, with the main model overloaded so the fast model answered). Results are in `eval/LIVE_RESULTS.md`.

## Considered and rejected

| Option | Why not |
|---|---|
| Vector DB for memory | One user's history is small, and dates matter more than similarity. Date filter plus BM25 is deterministic and sub-millisecond; the eval shows its limit (paraphrase). |
| LLM does date maths | The most common silent failure: the wrong day retrieves the wrong conversation. |
| Re-reading transcripts | Slow and vague. Atomic claims give a precise old → new diff. |
| Pure ReAct loop | Sequential searches are slow, and the model may skip facts. Fan-out in code guarantees coverage. |
| Memory as a second tool | The brief says one tool; retrieval runs before the model, so it can't forget to remember. |
| SQLite | Native builds can break `npm install`. An atomic JSON file is enough for one user. |

## With another week

1. Local embeddings plus a reranker for paraphrase recall, behind the same `retrieve()` interface.
2. Tell a real change apart from a corrected mistake, using source dates ("$10 → $25" may mean the old answer was wrong).
3. Hedged requests (start the fast model after 2 s and take the first to answer) to cut tail latency.
4. Proactive watch: scheduled re-checks of stale claims ("tell me if any of these CRMs changes price").
5. A larger live eval with an LLM judge, run on every change.
