# Scale phase2-after (2,002 files)

| Measure | Result | Budget |
|---|---|---|
| Index build (cold) | 2,975 ms | < 60,000 ms |
| Index size on disk | 4.7 MB | < 100 MB |
| `cb-trainer search` in a new process (CLI startup included) | 1,289 ms | |
| First search after the build, same process | 290 ms | |
| Search, warm p50 / p95 | 10 ms / 12 ms | p95 < 150 ms |
| Freshness check, nothing changed | 7 ms | |
| Search after editing one file | 9 ms | |
| feature_slice, warm p50 / max | 21 ms / 716 ms | |
| impact, warm p50 / max | 67 ms / 78 ms | |

Warm = later calls in the same process with the file watcher on, as in the MCP server. Synthetic code: speed and size only, not ranking quality.
