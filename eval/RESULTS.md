# Memory evaluation (offline)

Run with `npm run eval`. "Now" is fixed at Thu 12 Nov 2026, 22:30 IST so results are reproducible.
"(none)" cases check the agent will say it has no record instead of picking something.

- Cases: 31 questions over a 12-conversation, 3-week history
- Top-1 accuracy: 30/31 (97%)
- Recall@3: 30/31 (97%)
- Latency (dates + retrieval): p50 0.35 ms · p95 2.32 ms

| | Question | Dates resolved | Expected | Got |
|---|---|---|---|---|
| ✅ | On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since? | On Monday → Monday 9 November 2026 | crm | crm |
| ✅ | What did I ask you on 3 November? Is your answer still correct today? | 3 November → Tuesday 3 November 2026; today → Thursday 12 November 2026 | node | node |
| ✅ | Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then? | Last Tuesday → Tuesday 10 November 2026 | postgres | postgres |
| ✅ | On November 2nd I asked about the iPhone — any update? | November 2nd → Monday 2 November 2026 | iphone | iphone |
| ✅ | what did I ask you on 28 October | 28 October → Wednesday 28 October 2026 | tavily | tavily |
| ✅ | What did we discuss on 25 October? | 25 October → Sunday 25 October 2026 | (none) | (none) |
| ✅ | What did I ask on Sunday? | on Sunday → Sunday 8 November 2026 | (none) | (none) |
| ✅ | What did I ask you yesterday? | yesterday → Wednesday 11 November 2026 | headphones | headphones |
| ✅ | Earlier today I asked about the weather, is it still going to rain? | Earlier today → Thursday 12 November 2026 | weather | weather |
| ✅ | the day before yesterday I asked about a Python release | the day before yesterday → Tuesday 10 November 2026 | python | python |
| ✅ | 3 days ago I asked about CRMs | 3 days ago → Monday 9 November 2026 | crm | crm |
| ✅ | what did I ask you 2 days ago | 2 days ago → Tuesday 10 November 2026 | postgres / python | python |
| ✅ | Did the flight prices you found on Friday change? | on Friday → Friday 6 November 2026 | flights | flights |
| ✅ | Last Friday's flight search — are fares lower now? | Last Friday → Friday 6 November 2026 | flights | flights |
| ✅ | The Vercel vs Netlify thing from Thursday, still true? | Thursday → Thursday 5 November 2026 | vercel | vercel |
| ✅ | Last Tuesday I asked about the Node LTS version, is it still current? | Last Tuesday → Tuesday 10 November 2026 | node | node |
| ✅ | Last Saturday you told me Gemini API prices | Last Saturday → Saturday 7 November 2026 | gemini | gemini |
| ✅ | Last week you told me about Gemini API pricing. Did it change? | Last week → last week (2 Nov–8 Nov 2026) | gemini | gemini |
| ✅ | Remember the Kubernetes question from last month? | last month → October 2026 | k8s | k8s |
| ✅ | a week ago I asked about hosting a Next.js app | a week ago → around 5 November 2026 | vercel | vercel |
| ✅ | Is monday.com still cheaper than HubSpot? | — | crm | crm |
| ✅ | the headphones you recommended — still the best? | — | headphones | headphones |
| ✅ | Tell me about Neon and Supabase again | — | postgres | postgres |
| ✅ | What about the Node version you mentioned? | — | node | node |
| ✅ | Has the search API comparison changed — Exa or Tavily now? | — | tavily | tavily |
| ✅ | Is the Python release date you gave me still right? | — | python | python |
| ✅ | What did I ask you on Tuesday? | on Tuesday → Tuesday 10 November 2026 | postgres / python | python |
| ✅ | Is that rain forecast still on? | — | weather | weather |
| ✅ | the database hosting options you gave me — any cheaper now? | — | postgres | postgres |
| ✅ | that sales software list we made, still valid? | — | crm | crm |
| ❌ | any news on the new phone launch date? | — | iphone | weather |
