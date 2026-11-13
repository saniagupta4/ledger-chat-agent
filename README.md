# Ledger: a chat agent that remembers what it told you, and re-checks it

A web-search chat agent built for the Minimi hiring challenge. It answers with cited sources. It also keeps a dated **ledger of every checkable fact it states**, so questions like these get real answers:

> *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*
> *"What did I ask you on 3 November? Is your answer still correct today?"*

Architecture and trade-offs: **[DESIGN.md](./DESIGN.md)**.

## Run it

```bash
npm install
cp .env.example .env      # add TAVILY_API_KEY and one model key (Gemini, OpenAI or Anthropic)
npm run dev               # → http://localhost:3000
```

Requires Node 20+.

## Try the memory features

Real users ask about last week, but a reviewer starts with an empty history. There are two ways to fill it:

- **`npm run seed`** runs the real agent with its clock set to *3 November*, *last Monday* and *last Tuesday*. It asks about Node.js LTS, a CRM shortlist and Postgres hosting. Afterwards, ask the three sample questions from the brief.
- **The agent clock** (bottom of the sidebar) does the same by hand. Set it to an earlier date, ask something, click **Live**, then ask "has that changed since …?".

Open the **Fact ledger** panel to see every stored fact, its source and date, and each re-check result (unchanged / changed / unverifiable).

## Use the memory from Claude Desktop (MCP)

The fact ledger is also an MCP server with three read-only tools: `recall_conversations`, `fact_history` and `stale_facts`. Add this to Claude Desktop's `claude_desktop_config.json`, using the full path to this folder:

```json
{
  "mcpServers": {
    "ledger-memory": {
      "command": "npm",
      "args": ["run", "mcp", "--silent", "--prefix", "/full/path/to/this/folder"]
    }
  }
}
```

On Windows, use `"command": "npm.cmd"`. Then ask Claude: *"Using ledger-memory, how has Neon's pricing changed?"*

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server and UI |
| `npm run doctor` | Check keys, models and search; prints what is wrong |
| `npm test` | Full pipeline tests with a scripted model and fake web (no keys needed) |
| `npm run typecheck` | TypeScript strict check |
| `npm run eval` | Memory-retrieval eval on 31 realistic questions (no keys) → `eval/RESULTS.md` |
| `npm run eval:live` | End-to-end eval with the real model and search (needs keys) → `eval/LIVE_RESULTS.md` |
| `npm run seed` | Build a real multi-day history (needs keys) |
| `npm run mcp` | Memory ledger as an MCP server (stdio) |

## Layout

```
src/
  server.ts            HTTP + SSE streaming (Hono)
  agent/agent.ts       one turn: dates → memory → route → evidence → answer → save
  agent/router.ts      picks direct | search | recall | recall_verify, plans parallel queries
  agent/verify.ts      re-checks stored claims: parallel fan-out + structured comparison
  agent/extract.ts     turns an answer into episode + atomic claims (background)
  agent/prompts.ts     answer rules and context assembly
  time/resolve.ts      "last Tuesday" → a date range, in the user's timezone
  memory/              JSON store, retrieval (date filter + BM25)
  search/              Tavily client (cache, timeout), numbered sources
  llm/                 provider-agnostic LLM interface (AI SDK)
  mcp/ + mcp.ts        the ledger as a read-only MCP server
public/                chat UI (plain JS, no build step)
test/                  node:test suites + fakes
eval/                  offline + live evaluations
```
