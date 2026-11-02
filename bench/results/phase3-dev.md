# Benchmark phase3 (dev questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 33% | 60% | 0.48 | 1,501 | 45% | 7,175 |
| taxonomy | grep baseline | 33% | 53% | 0.46 | 1,397 | 27% | — |
| express-realworld | codebase-trainer | 53% | 87% | 0.65 | 1,948 | 62% | — |
| express-realworld | grep baseline | 47% | 67% | 0.58 | 3,345 | 39% | — |
| nestjs-realworld | codebase-trainer | 87% | 93% | 0.91 | 341 | 76% | 6,252 |
| nestjs-realworld | grep baseline | 13% | 67% | 0.37 | 2,375 | 53% | — |
| t3-turbo | codebase-trainer | 53% | 87% | 0.68 | 938 | 48% | 8,530 |
| t3-turbo | grep baseline | 13% | 67% | 0.40 | 4,340 | 44% | — |
| **all** | codebase-trainer | 57% | 82% | 0.68 | 952 | 58% | 7,175 |
| **all** | grep baseline | 27% | 63% | 0.45 | 3,660 | 41% | — |

| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |
|---|---|---|---|---|---|---|
| taxonomy | 140 / 169 | 0.7 s | 1.5 MB | 74 ms | 607 ms | none |
| express-realworld | 58 / 64 | 0.2 s | 3.1 MB | 96 ms | 287 ms | none |
| nestjs-realworld | 43 / 118 | 0.2 s | 3.0 MB | 81 ms | 196 ms | none |
| t3-turbo | 116 / 136 | 0.2 s | 0.9 MB | 54 ms | 244 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
