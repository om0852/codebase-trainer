# Benchmark phase1 (all questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 35% | 70% | 0.52 | 1,475 | 36% | — |
| taxonomy | grep baseline | 25% | 50% | 0.38 | 3,129 | 26% | — |
| express-realworld | codebase-trainer | 55% | 90% | 0.67 | 1,526 | 53% | — |
| express-realworld | grep baseline | 40% | 75% | 0.55 | 3,345 | 40% | — |
| nestjs-realworld | codebase-trainer | 85% | 90% | 0.89 | 937 | 73% | 6,553 |
| nestjs-realworld | grep baseline | 20% | 65% | 0.40 | 2,101 | 50% | — |
| t3-turbo | codebase-trainer | 55% | 85% | 0.69 | 560 | 53% | 7,856 |
| t3-turbo | grep baseline | 10% | 70% | 0.39 | 4,340 | 42% | — |
| **all** | codebase-trainer | 57% | 84% | 0.69 | 963 | 54% | 7,205 |
| **all** | grep baseline | 24% | 65% | 0.43 | 3,974 | 40% | — |

| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |
|---|---|---|---|---|---|---|
| taxonomy | 139 / 169 | 0.4 s | 1.5 MB | 57 ms | 67 ms | `prisma/schema.prisma` |
| express-realworld | 57 / 64 | 0.2 s | 3.1 MB | 64 ms | 111 ms | `src/prisma/schema.prisma` |
| nestjs-realworld | 43 / 118 | 0.1 s | 3.0 MB | 55 ms | 63 ms | none |
| t3-turbo | 116 / 136 | 0.1 s | 0.9 MB | 41 ms | 45 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
