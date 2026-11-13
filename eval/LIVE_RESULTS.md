# Live evaluation

Run on 13 Nov 2026, 13:35 with `npm run eval:live`.

- Model: google · main gemini-3.8-flash · fast gemini-flash-lite-latest
- Passed: 8/8
- Planning (router): p50 1.4s · Searching / re-checking: p50 3.4s
- Time to first word: p50 6.6s · p90 14.6s
- Full answer: p50 7.2s · p90 15.4s

| | Question | Path | Recalled | Plan | Search | First word | Total | Problems |
|---|---|---|---|---|---|---|---|---|
| ✅ | On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them | recall_verify | crm | 1.2s | 7.2s | 9.9s | 11.0s |  |
| ✅ | What did I ask you on 3 November? Is your answer still correct today? | recall_verify | node | 1.9s | 3.7s | 6.6s | 7.2s |  |
| ✅ | Last Tuesday I asked you about Postgres hosting. Has any pricing changed since t | recall_verify | postgres | 1.7s | 11.6s | 14.6s | 15.4s |  |
| ✅ | What did I ask you on 25 October? | recall | — | 1.4s | — | 2.6s | 2.7s |  |
| ✅ | Who is the current CEO of OpenAI? | search | — | 1.7s | 1.4s | 4.4s | 4.5s |  |
| ✅ | What changed in the latest stable Rust release? | search | — | 1.1s | 3.4s | 8.6s | 9.0s |  |
| ✅ | hi! | direct | — | 0.0s | — | 1.5s | 1.5s |  |
| ✅ | Explain what a B-tree index is in two sentences. | direct | — | 1.4s | — | 2.2s | 2.3s |  |
