# Benchmark phase2-check (all questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 35% | 70% | 0.53 | 1,475 | 41% | 7,069 |
| taxonomy | grep baseline | 25% | 50% | 0.38 | 3,129 | 37% | — |
| express-realworld | codebase-trainer | 55% | 90% | 0.67 | 2,647 | 66% | 7,506 |
| express-realworld | grep baseline | 40% | 75% | 0.55 | 3,345 | 40% | — |
| nestjs-realworld | codebase-trainer | 85% | 90% | 0.89 | 937 | 73% | 6,553 |
| nestjs-realworld | grep baseline | 20% | 65% | 0.40 | 2,101 | 50% | — |
| t3-turbo | codebase-trainer | 65% | 85% | 0.74 | 459 | 55% | 8,952 |
| t3-turbo | grep baseline | 10% | 75% | 0.40 | 4,340 | 42% | — |
| **all** | codebase-trainer | 60% | 84% | 0.71 | 1,062 | 59% | 7,506 |
| **all** | grep baseline | 24% | 66% | 0.43 | 3,974 | 42% | — |

**feature_slice** on feature questions (one call, default 6,000-token budget):

| Repo | Questions | Recall | Precision | Fully covered | Median tokens | Median files |
|---|---|---|---|---|---|---|
| taxonomy | 6 | 76% | 32% | 50% | 3,825 | 16 |
| express-realworld | 6 | 97% | 38% | 83% | 5,181 | 16 |
| nestjs-realworld | 6 | 95% | 40% | 67% | 4,649 | 16 |
| t3-turbo | 6 | 61% | 23% | 0% | 4,702 | 16 |
| **all** | 24 | 83% | 33% | 50% | 4,552 | 16 |

| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |
|---|---|---|---|---|---|---|
| taxonomy | 140 / 169 | 0.5 s | 0.9 MB | 22 ms | 25 ms | none |
| express-realworld | 58 / 64 | 0.3 s | 2.1 MB | 12 ms | 14 ms | none |
| nestjs-realworld | 43 / 118 | 0.2 s | 2.1 MB | 9 ms | 10 ms | none |
| t3-turbo | 116 / 136 | 0.3 s | 0.6 MB | 20 ms | 22 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
