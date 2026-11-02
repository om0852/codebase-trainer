# Cross-stack linking phase3 (tree-sitter)

| Repo | Client request sites | Linked to a handler | Server routes | Data-layer edges | Cross-file calls | Same-file calls |
|---|---|---|---|---|---|---|
| taxonomy | 5 | 5 (100%) | 8 | 13 | 296 | 27 |
| express-realworld | 1 | 1 (100%) | 20 | 36 | 58 | 6 |
| nestjs-realworld | 0 | 0 (—) | 21 | 43 | 28 | 7 |
| t3-turbo | 12 | 12 (100%) | 0 | 4 | 111 | 26 |
| **all** | 18 | 18 (100%) | | | | |

Request sites are fetch/axios/wrapper calls and tRPC calls that perform a request (queryOptions, mutationOptions, useQuery, ...).
