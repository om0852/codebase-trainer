# Scale phase2-before (10,000 files)

| Measure | Result | Budget |
|---|---|---|
| Index build (cold) | 13,354 ms | < 60,000 ms |
| Index size on disk | 40.9 MB | < 100 MB |
| First search in a new process | 29,781 ms | |
| Search, warm p50 / p95 | 2,089 ms / 2,656 ms | p95 < 150 ms |
| Freshness check, nothing changed | 1,540 ms | |
| Search after editing one file | 30,899 ms | |
| feature_slice, warm p50 / max | 16,651 ms / 71,603 ms | |
| impact, warm p50 / max | 25,717 ms / 34,288 ms | |

Warm = later calls in the same process, as in the MCP server. Synthetic code: speed and size only, not ranking quality.
