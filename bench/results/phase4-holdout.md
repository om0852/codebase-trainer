# Benchmark phase4 (holdout questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 40% | 100% | 0.67 | 1,475 | 25% | — |
| taxonomy | grep baseline | 0% | 40% | 0.14 | 14,323 | 25% | — |
| express-realworld | codebase-trainer | 60% | 100% | 0.71 | 3,345 | 75% | 7,506 |
| express-realworld | grep baseline | 20% | 100% | 0.47 | 4,386 | 42% | — |
| nestjs-realworld | codebase-trainer | 80% | 80% | 0.82 | 1,615 | 69% | 56,066 |
| nestjs-realworld | grep baseline | 40% | 60% | 0.50 | 1,615 | 45% | — |
| t3-turbo | codebase-trainer | 80% | 80% | 0.82 | 311 | 69% | — |
| t3-turbo | grep baseline | 0% | 80% | 0.36 | 4,001 | 38% | — |
| **all** | codebase-trainer | 65% | 90% | 0.75 | 1,524 | 60% | 7,506 |
| **all** | grep baseline | 15% | 70% | 0.37 | 4,001 | 38% | — |

**feature_slice** on feature questions (one call, default 6,000-token budget):

| Repo | Questions | Recall | Precision | Fully covered | Median tokens | Median files |
|---|---|---|---|---|---|---|
| taxonomy | 2 | 83% | 31% | 50% | 3,994 | 16 |
| express-realworld | 2 | 100% | 38% | 100% | 4,645 | 16 |
| nestjs-realworld | 2 | 92% | 38% | 50% | 5,113 | 16 |
| t3-turbo | 2 | 62% | 25% | 0% | 4,217 | 16 |
| **all** | 8 | 84% | 33% | 50% | 4,432 | 16 |

| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |
|---|---|---|---|---|---|---|
| taxonomy | 140 / 169 | 0.4 s | 1.5 MB | 77 ms | 390 ms | none |
| express-realworld | 58 / 64 | 0.2 s | 3.1 MB | 75 ms | 180 ms | none |
| nestjs-realworld | 43 / 118 | 0.2 s | 3.0 MB | 59 ms | 190 ms | none |
| t3-turbo | 116 / 136 | 0.2 s | 0.9 MB | 58 ms | 203 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
