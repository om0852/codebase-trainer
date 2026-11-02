# Benchmark phase1 (holdout questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 40% | 100% | 0.67 | 1,475 | 25% | — |
| taxonomy | grep baseline | 0% | 40% | 0.14 | 14,323 | 25% | — |
| express-realworld | codebase-trainer | 60% | 100% | 0.72 | 3,345 | 67% | — |
| express-realworld | grep baseline | 20% | 100% | 0.47 | 4,386 | 42% | — |
| nestjs-realworld | codebase-trainer | 80% | 80% | 0.82 | 1,615 | 69% | 56,088 |
| nestjs-realworld | grep baseline | 40% | 60% | 0.50 | 1,615 | 45% | — |
| t3-turbo | codebase-trainer | 80% | 80% | 0.83 | 311 | 69% | — |
| t3-turbo | grep baseline | 0% | 80% | 0.36 | 4,001 | 38% | — |
| **all** | codebase-trainer | 65% | 90% | 0.76 | 1,524 | 57% | 56,088 |
| **all** | grep baseline | 15% | 70% | 0.37 | 4,001 | 38% | — |

| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |
|---|---|---|---|---|---|---|
| taxonomy | 139 / 169 | 0.3 s | 1.5 MB | 59 ms | 296 ms | `prisma/schema.prisma` |
| express-realworld | 57 / 64 | 0.2 s | 3.1 MB | 66 ms | 168 ms | `src/prisma/schema.prisma` |
| nestjs-realworld | 43 / 118 | 0.2 s | 3.0 MB | 57 ms | 159 ms | none |
| t3-turbo | 116 / 136 | 0.2 s | 0.9 MB | 45 ms | 185 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
