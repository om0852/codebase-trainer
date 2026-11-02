# Scale phase2-after (10,000 files)

| Measure | Result | Budget |
|---|---|---|
| Index build (cold) | 13,464 ms | < 60,000 ms |
| Index size on disk | 23.8 MB | < 100 MB |
| `cb-trainer search` in a new process (CLI startup included) | 3,180 ms | |
| First search after the build, same process | 1,243 ms | |
| Search, warm p50 / p95 | 43 ms / 50 ms | p95 < 150 ms |
| Freshness check, nothing changed | 26 ms | |
| Search after editing one file | 38 ms | |
| feature_slice, warm p50 / max | 88 ms / 3,365 ms | |
| impact, warm p50 / max | 312 ms / 337 ms | |

Warm = later calls in the same process with the file watcher on, as in the MCP server. Synthetic code: speed and size only, not ranking quality.
