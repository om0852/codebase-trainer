# Benchmark phase1 (dev questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 33% | 60% | 0.47 | 1,501 | 42% | — |
| taxonomy | grep baseline | 33% | 53% | 0.46 | 1,397 | 27% | — |
| express-realworld | codebase-trainer | 53% | 87% | 0.66 | 1,423 | 45% | — |
| express-realworld | grep baseline | 47% | 67% | 0.58 | 3,345 | 39% | — |
| nestjs-realworld | codebase-trainer | 87% | 93% | 0.91 | 341 | 76% | 6,252 |
| nestjs-realworld | grep baseline | 13% | 67% | 0.37 | 2,375 | 53% | — |
| t3-turbo | codebase-trainer | 47% | 87% | 0.65 | 938 | 44% | 7,856 |
| t3-turbo | grep baseline | 13% | 67% | 0.40 | 4,340 | 44% | — |
| **all** | codebase-trainer | 55% | 82% | 0.67 | 945 | 52% | 7,054 |
| **all** | grep baseline | 27% | 63% | 0.45 | 3,660 | 41% | — |

| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |
|---|---|---|---|---|---|---|
| taxonomy | 139 / 169 | 0.3 s | 1.5 MB | 57 ms | 304 ms | `prisma/schema.prisma` |
| express-realworld | 57 / 64 | 0.2 s | 3.1 MB | 65 ms | 171 ms | `src/prisma/schema.prisma` |
| nestjs-realworld | 43 / 118 | 0.1 s | 3.0 MB | 56 ms | 134 ms | none |
| t3-turbo | 116 / 136 | 0.1 s | 0.9 MB | 40 ms | 170 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
