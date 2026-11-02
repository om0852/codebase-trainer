# Benchmark phase4 (dev questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 33% | 60% | 0.48 | 1,501 | 49% | 7,069 |
| taxonomy | grep baseline | 33% | 53% | 0.46 | 1,397 | 43% | — |
| express-realworld | codebase-trainer | 53% | 87% | 0.65 | 1,948 | 62% | — |
| express-realworld | grep baseline | 47% | 67% | 0.58 | 3,345 | 39% | — |
| nestjs-realworld | codebase-trainer | 87% | 93% | 0.91 | 341 | 76% | 5,805 |
| nestjs-realworld | grep baseline | 13% | 67% | 0.37 | 2,375 | 53% | — |
| t3-turbo | codebase-trainer | 60% | 87% | 0.71 | 938 | 48% | 8,952 |
| t3-turbo | grep baseline | 13% | 73% | 0.41 | 4,340 | 44% | — |
| **all** | codebase-trainer | 58% | 82% | 0.69 | 952 | 59% | 7,637 |
| **all** | grep baseline | 27% | 65% | 0.45 | 3,660 | 45% | — |

**feature_slice** on feature questions (one call, default 6,000-token budget):

| Repo | Questions | Recall | Precision | Fully covered | Median tokens | Median files |
|---|---|---|---|---|---|---|
| taxonomy | 4 | 73% | 33% | 50% | 3,692 | 16 |
| express-realworld | 4 | 96% | 38% | 75% | 5,205 | 16 |
| nestjs-realworld | 4 | 97% | 41% | 75% | 4,481 | 16 |
| t3-turbo | 4 | 61% | 22% | 0% | 4,702 | 16 |
| **all** | 16 | 82% | 33% | 50% | 4,552 | 16 |

| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |
|---|---|---|---|---|---|---|
| taxonomy | 140 / 169 | 0.4 s | 1.5 MB | 89 ms | 382 ms | none |
| express-realworld | 58 / 64 | 0.3 s | 3.1 MB | 85 ms | 213 ms | none |
| nestjs-realworld | 43 / 118 | 0.2 s | 3.0 MB | 63 ms | 154 ms | none |
| t3-turbo | 116 / 136 | 0.2 s | 0.9 MB | 44 ms | 192 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
