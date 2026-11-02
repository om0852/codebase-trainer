# Permission map phase5-regex (regex)

| Repo | Routes | Auth correct | Required / optional / none | Findings | False positives | Missed |
|---|---|---|---|---|---|---|
| taxonomy | 8 | 8 | 6 / 0 / 2 | 0 | 0 | 0 |
| express-realworld | 8 | 8 | 3 / 2 / 3 | 0 | 0 | 0 |
| nestjs-realworld | 0 | 0 | 0 / 0 / 0 | 0 | 0 | 1 |
| t3-turbo | 8 | 8 | 3 / 1 / 4 | 0 | 0 | 0 |
| **all** | 24 | 24 (100%) | | 0 | 0 | 1 |

Mismatches:

- nestjs-realworld: missed route-without-auth DELETE /api/users/:slug

Labels (bench/permissions.json) were written by reading each handler and its middleware. These repos use no scopes, so only route-without-auth is exercised here; the scope rules are covered by fixtures in tests/permissionMap.test.ts.
