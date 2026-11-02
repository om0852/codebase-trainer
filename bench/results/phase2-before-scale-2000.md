# Scale phase2-before (2,002 files)

| Measure | Result | Budget |
|---|---|---|
| Index build (cold) | 3,466 ms | < 60,000 ms |
| Index size on disk | 8.2 MB | < 100 MB |
| First search in a new process | 3,981 ms | |
| Search, warm p50 / p95 | 512 ms / 805 ms | p95 < 150 ms |
| Freshness check, nothing changed | 353 ms | |
| Search after editing one file | 3,672 ms | |
| feature_slice, warm p50 / max | 1,760 ms / 6,238 ms | |
| impact, warm p50 / max | 2,651 ms / 3,325 ms | |

Warm = later calls in the same process, as in the MCP server. Synthetic code: speed and size only, not ranking quality.
