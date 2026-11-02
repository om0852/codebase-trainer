# Benchmark phase6-neural (dev questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 47% | 93% | 0.63 | 1,151 | 58% | 4,783 |
| taxonomy | grep baseline | 33% | 53% | 0.46 | 1,397 | 43% | — |
| express-realworld | codebase-trainer | 53% | 93% | 0.71 | 1,062 | 62% | — |
| express-realworld | grep baseline | 47% | 67% | 0.58 | 3,345 | 39% | — |
| nestjs-realworld | codebase-trainer | 80% | 100% | 0.87 | 865 | 83% | 3,618 |
| nestjs-realworld | grep baseline | 13% | 67% | 0.37 | 2,375 | 53% | — |
| t3-turbo | codebase-trainer | 60% | 93% | 0.74 | 772 | 57% | 8,680 |
| t3-turbo | grep baseline | 13% | 73% | 0.41 | 4,340 | 44% | — |
| **all** | codebase-trainer | 60% | 95% | 0.74 | 937 | 65% | 6,551 |
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
| taxonomy | 140 / 169 | 1.4 s | 1.5 MB | 128 ms | 265 ms | none |
| express-realworld | 58 / 64 | 0.2 s | 3.1 MB | 129 ms | 159 ms | none |
| nestjs-realworld | 43 / 118 | 0.2 s | 3.0 MB | 119 ms | 184 ms | none |
| t3-turbo | 116 / 136 | 0.3 s | 0.9 MB | 95 ms | 100 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
