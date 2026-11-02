# Benchmark phase3 (all questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 35% | 70% | 0.53 | 1,475 | 38% | 7,175 |
| taxonomy | grep baseline | 25% | 50% | 0.38 | 3,129 | 26% | — |
| express-realworld | codebase-trainer | 55% | 90% | 0.67 | 2,647 | 66% | 7,986 |
| express-realworld | grep baseline | 40% | 75% | 0.55 | 3,345 | 40% | — |
| nestjs-realworld | codebase-trainer | 85% | 90% | 0.89 | 937 | 73% | 6,553 |
| nestjs-realworld | grep baseline | 20% | 65% | 0.40 | 2,101 | 50% | — |
| t3-turbo | codebase-trainer | 60% | 85% | 0.72 | 459 | 52% | 8,530 |
| t3-turbo | grep baseline | 10% | 70% | 0.39 | 4,340 | 42% | — |
| **all** | codebase-trainer | 59% | 84% | 0.70 | 1,062 | 58% | 7,581 |
| **all** | grep baseline | 24% | 65% | 0.43 | 3,974 | 40% | — |

| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |
|---|---|---|---|---|---|---|
| taxonomy | 140 / 169 | 0.8 s | 1.5 MB | 118 ms | 263 ms | none |
| express-realworld | 58 / 64 | 0.4 s | 3.1 MB | 120 ms | 226 ms | none |
| nestjs-realworld | 43 / 118 | 0.4 s | 3.0 MB | 77 ms | 118 ms | none |
| t3-turbo | 116 / 136 | 0.4 s | 0.9 MB | 54 ms | 70 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
