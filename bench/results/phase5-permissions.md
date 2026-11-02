# Permission map phase5 (tree-sitter)

| Repo | Routes | Auth correct | Required / optional / none | Findings | False positives | Missed |
|---|---|---|---|---|---|---|
| taxonomy | 8 | 8 | 6 / 0 / 2 | 0 | 0 | 0 |
| express-realworld | 20 | 20 | 12 / 5 / 3 | 0 | 0 | 0 |
| nestjs-realworld | 21 | 21 | 12 / 0 / 9 | 1 | 0 | 0 |
| t3-turbo | 8 | 8 | 3 / 1 / 4 | 0 | 0 | 0 |
| **all** | 57 | 57 (100%) | | 1 | 0 | 0 |

No mismatches against the labels.

Labels (bench/permissions.json) were written by reading each handler and its middleware. These repos use no scopes, so only route-without-auth is exercised here; the scope rules are covered by fixtures in tests/permissionMap.test.ts.
