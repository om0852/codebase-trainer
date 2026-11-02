# Benchmark phase6-neural (holdout questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 40% | 80% | 0.63 | 586 | 42% | — |
| taxonomy | grep baseline | 0% | 40% | 0.14 | 14,323 | 25% | — |
| express-realworld | codebase-trainer | 60% | 100% | 0.77 | 3,345 | 83% | 7,042 |
| express-realworld | grep baseline | 20% | 100% | 0.47 | 4,386 | 42% | — |
| nestjs-realworld | codebase-trainer | 80% | 80% | 0.83 | 1,615 | 77% | 6,622 |
| nestjs-realworld | grep baseline | 40% | 60% | 0.50 | 1,615 | 45% | — |
| t3-turbo | codebase-trainer | 80% | 100% | 0.84 | 311 | 61% | — |
| t3-turbo | grep baseline | 0% | 80% | 0.36 | 4,001 | 38% | — |
| **all** | codebase-trainer | 65% | 90% | 0.77 | 1,073 | 66% | 6,735 |
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
| taxonomy | 140 / 169 | 0.5 s | 1.5 MB | 112 ms | 145 ms | none |
| express-realworld | 58 / 64 | 0.3 s | 3.1 MB | 150 ms | 199 ms | none |
| nestjs-realworld | 43 / 118 | 0.3 s | 3.0 MB | 123 ms | 253 ms | none |
| t3-turbo | 116 / 136 | 0.3 s | 0.9 MB | 87 ms | 101 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
