# Benchmark phase6-neural (all questions, 2026-11-02)

| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |
|---|---|---|---|---|---|---|---|
| taxonomy | codebase-trainer | 45% | 90% | 0.63 | 1,053 | 52% | 4,783 |
| taxonomy | grep baseline | 25% | 50% | 0.38 | 3,129 | 37% | — |
| express-realworld | codebase-trainer | 55% | 95% | 0.72 | 1,062 | 69% | 7,042 |
| express-realworld | grep baseline | 40% | 75% | 0.55 | 3,345 | 40% | — |
| nestjs-realworld | codebase-trainer | 80% | 95% | 0.86 | 937 | 81% | 6,509 |
| nestjs-realworld | grep baseline | 20% | 65% | 0.40 | 2,101 | 50% | — |
| t3-turbo | codebase-trainer | 65% | 95% | 0.77 | 530 | 58% | 8,680 |
| t3-turbo | grep baseline | 10% | 75% | 0.40 | 4,340 | 42% | — |
| **all** | codebase-trainer | 61% | 94% | 0.75 | 945 | 65% | 6,735 |
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
| taxonomy | 140 / 169 | 0.9 s | 1.5 MB | 163 ms | 209 ms | none |
| express-realworld | 58 / 64 | 0.3 s | 3.1 MB | 137 ms | 155 ms | none |
| nestjs-realworld | 43 / 118 | 0.2 s | 3.0 MB | 107 ms | 162 ms | none |
| t3-turbo | 116 / 136 | 0.2 s | 0.9 MB | 88 ms | 102 ms | none |

Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.
