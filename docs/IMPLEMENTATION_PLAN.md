# codebase-trainer 2.0 — Implementation Plan

**Status:** proposal · **Baseline:** v1.4.0 · **Owner:** codebase-trainer maintainers

---

## 1. Goal and positioning

**One-line pitch:** *One call gives an AI coding agent everything a feature touches — UI, state, API client, route handler, service, database schema, auth checks and tests — with `file:line` evidence, inside a token budget, fully offline.*

We are **not** trying to beat every code-intelligence tool. We compete in one area — **full-stack feature context for AI agents** — and aim to be measurably best there for JavaScript/TypeScript web applications (Next.js, Express, NestJS, tRPC, Prisma/Drizzle), then extend.

### Who uses it and what they get

| User | Day-to-day use | Value we must deliver |
|---|---|---|
| Individual developer | Claude Code / Cursor asks "where is X", "what breaks if I change Y" | Right files in the first answer; fewer tokens per task; zero setup |
| Startup team | Shared conventions, PR checks, onboarding new devs to the codebase | Learned conventions, diff review in CI, feature maps |
| Enterprise / MNC | Large monorepos, strict data policies, many teams | Fully offline (no code leaves the machine), scales to 50k+ files, monorepo/workspace aware, deterministic and auditable output |

### The value we promise, in numbers

Every claim in the README must be backed by the public benchmark (§3):

- **Tokens:** an agent reaches the files needed for a task with **≥50% fewer tokens** than grep-and-read.
- **Accuracy:** recall@5 for "where is this implemented" questions **≥0.85** on the benchmark repos.
- **Speed:** query latency **<150 ms p95** on a 10k-file repo once the server is warm; initial index **<60 s** for 10k files.
- **Setup:** from nothing to working MCP in **one command, under 2 minutes**.

---

## 2. Who we compete with (and how we win)

| Area | Tools to beat | Their strength | How we win |
|---|---|---|---|
| Feature/context retrieval for agents | claude-context (Zilliz), Augment Context Engine, Cursor/Copilot built-in indexing | Neural embeddings, polished UX | Cross-stack *feature slices* (no one links UI → API → handler → DB → auth), zero setup, offline, token-budgeted output |
| Code navigation | Serena (LSP), Sourcegraph | Exact symbols and references | We don't chase full parity; we use tree-sitter + optional TypeScript compiler for precision where it matters (TS/JS) |
| Repo maps / context packing | Aider repo map, Repomix | Simple, proven | Graph-ranked packs focused on a task instead of a whole-repo dump |
| Diff review | CodeRabbit (cloud), Semgrep | Breadth of rules / LLM review | Offline, deterministic, cross-stack checks: removed exports still imported, API contract drift, **permission mismatches** |
| API/contract analysis | OpenAPI tooling, framework-specific linters | Spec-driven | Works on code without a spec, across frontend and backend |

**Areas we explicitly leave to others:** general-purpose LSP navigation for every language, LLM-written review comments, hosted multi-repo code search.

---

## 3. Phase 0 — Benchmark and test infrastructure (weeks 1–2)

Nothing else ships without this: every later phase must show a benchmark delta.

### 3.1 Benchmark harness (`bench/`)

- **Corpus:** 4 pinned open-source repos (exact commit SHAs) covering our niche, e.g. a Next.js App Router SaaS, an Express + React app, a NestJS + Prisma API, a tRPC monorepo. Cloned by script, never vendored.
- **Question sets** (`bench/questions/*.yaml`), 50–100 per repo, each labelled with the files (and optionally lines) that answer it:
  - `locate` — "where is password reset implemented"
  - `feature` — "everything involved in deleting an API key" (multi-file ground truth)
  - `impact` — "what breaks if `UserService.create` changes signature"
  - `flow` — "how does a checkout request reach the database"
- **Metrics:** recall@k, MRR, precision of feature slices, **tokens-to-answer** (tokens an agent must read before all labelled files are seen), latency p50/p95, index time, index size.
- **Baselines:** `grep`+read (scripted), and where licensing allows, Serena and claude-context run on the same questions.
- **Output:** `bench/results/<version>.json` + Markdown table; CI job fails if a PR regresses recall@5 or MRR by more than 2 points.

### 3.2 Test infrastructure

- Move from the single `tests/unit.test.ts` script to `node:test` (no extra dependency) with one file per module and shared fixture builders (`tests/fixtures/`).
- Fixture repos as small directories checked into `tests/fixtures/repos/` (Next.js, Express, Python) instead of strings built inside tests.
- Performance test: generate a synthetic 10k-file repo, assert index time and query latency budgets.
- CI matrix: Linux, macOS, Windows × Node 22/24 (Node 18 and 20 are end-of-life).

**Done when:** `npm run bench` produces a results table for v1.4.0 on all 4 repos; CI runs tests on 3 OSes; the README links the first published numbers.

**Status (done):** 104 questions labelled (80 locate, 24 feature; 28 held out) on taxonomy, node-express-realworld, nestjs-realworld and create-t3-turbo. v1.4.0 results: locate hit@1 56% vs grep 24%, MRR 0.69 vs 0.43, median 993 vs 3,974 tokens to the right file; feature recall@10 54% vs 40%, but only 17% of features fully covered in the top 20. Gaps found: `.prisma` files are not indexed; a crash on array-valued tsconfig `extends` (fixed). Tests run on `node:test` (38 tests, 9 files); CI runs 3 OSes × Node 22/24 plus a benchmark regression job on the dev split.

---

## 4. Phase 1 — Accurate parsing with tree-sitter (weeks 3–5)

Replace regex extraction with syntax trees, which fixes most accuracy gaps at once.

### Design

- New module `src/parsing/`:
  - `parser.ts` — loads `web-tree-sitter` (WebAssembly, no native build) and grammars on demand: TypeScript/TSX, JavaScript, Python, Go, Java (grammar `.wasm` files shipped in the package, ~2–4 MB total).
  - `queries/<language>.scm` — tree-sitter queries for definitions, imports, exports, calls, decorators, string literals passed to `fetch`/HTTP clients.
  - `facts.ts` — produces a richer `FileFacts`: symbols with kind, range, signature, exported flag, enclosing class; imports with bindings; call sites with callee expression and enclosing symbol.
- `ASTExtractor` keeps its public API and becomes a thin adapter, so existing tools keep working while being upgraded one by one.
- **Fallback:** if a grammar is missing, use today's regex extractor (no regression for unsupported languages).

### Unlocks

- Intra-file calls in flow traces (today's main flow limitation).
- **Signature-change detection** in the diff checker (`changed-signature-still-called`).
- Correct enclosing symbols, decorators (NestJS routes, Python Flask/FastAPI routes), class methods.

### Optional precise mode (TypeScript only)

If the target repo has `typescript` installed, use the compiler API (`ts.createProgram` with the repo's `tsconfig`) to resolve imports and references exactly. Off by default for repos over a size threshold; enabled with `precision: "typescript"` in config.

**Done when:** benchmark recall@5 improves on all repos; flow traces include same-file calls; all existing tests pass through the new extractor.

**Status (core done):** `web-tree-sitter` 0.27 with committed TypeScript, TSX, JavaScript and Python grammars (`grammars/`, ~3.7 MB), initialised once at startup with a regex fallback (`CODEBASE_TRAINER_PARSER=regex` forces it). Symbols, imports, signatures, decorators, call sites and nesting come from the syntax tree; flow edges grew from 274 to 460 on this repo, including same-file calls, JSX renders and handlers nested in components, and traces now read in execution order. Syntax-aligned chunking left ranking flat (MRR 0.69 → 0.69, hit@5 83% → 84%) but made the index 20–25% smaller and search faster (t3-turbo p95 150 → 45 ms). The "recall improves on all repos" criterion was **not** met: ranking, not parsing, is the limit, which Phases 3–4 address. Not yet done: the diff checker's signature-change check, the optional TypeScript-compiler precision mode, and Go/Java grammars.

---

## 5. Phase 2 — Storage and a long-running server (weeks 4–6)

Before Phase 2: a JSON index re-read on every query and several full re-scans per tool call.

### Design

- **SQLite store** (`src/store/`), via Node's built-in `node:sqlite` (Node 22+), behind a `Store` interface with the current JSON store as a fallback for older Node:
  - tables: `files(path, hash, mtime, size, language)`, `symbols`, `imports`, `calls`, `http_edges`, `chunks(id, file, start, end, text)`, `chunk_terms` (inverted index for BM25), `vectors` (optional, Phase 6), `meta(tokenizer_version, schema_version)`.
  - FTS5 virtual table for BM25 if available, otherwise our own term table.
- **Incremental pipeline:** file change → re-parse that file → update its rows → recompute only affected graph edges. PageRank recomputed lazily.
- **Server mode:** the MCP server keeps the store open and a file watcher running, so queries never re-scan. The CLI uses the same store.
- **Monorepos:** detect workspaces (`package.json` workspaces, pnpm, Nx, Turborepo); module names resolve across packages (`@acme/ui` → `packages/ui/src`).

**Done when:** 10k-file synthetic repo meets the §1 latency and index-time budgets; index size under 100 MB; no tool performs a full re-scan while the server is running.

**Status (done for 10k files):** measured with `npm run bench:scale` (`bench/scale.ts`). It generates a deterministic Next.js + Prisma repo of 10,000 files and times each tool warm in one process with the watcher on, as the server runs.

| 10,000 files | Before Phase 2 | After | Budget |
|---|---|---|---|
| Index build | 13.4 s | 13.5 s | < 60 s |
| Index size | 40.9 MB | 23.8 MB | < 100 MB |
| Search, warm p50 / p95 | 2,089 / 2,656 ms | **43 / 50 ms** | p95 < 150 ms |
| Search after editing one file | 30.9 s | **38 ms** | |
| `feature_slice`, warm p50 | 16.7 s | **88 ms** | |
| `impact`, warm p50 | 25.7 s | **312 ms** | |
| `cb-trainer search` in a new process | about 30 s | **3.2 s** | |

What changed:

- **SQLite store** (`src/storage/chunkStore.ts`, built-in `node:sqlite`, no new dependency).
  - It has `meta`, `files`, `chunks` (embedding as a float32 blob, paths relative to the repo) and `pagerank` tables.
  - A refresh rewrites only the changed files' rows. A process keeps the index in memory and patches it on its own writes; a generation counter picks up other processes' writes.
  - A connection is opened per operation, because an open handle locks the file on Windows.
  - The JSON store remains for encrypted indexes and for Node versions without `node:sqlite`.
  - PageRank scores are computed at build time and stored, so a new process no longer re-analyses every file before its first search.
- **No re-scans in the server.**
  - `RepoWatch` records changed paths, and the file listing patches them instead of walking the tree. It falls back to a full walk when ignore rules or directories change, after more than 500 changes, and at least every 10 minutes.
  - File contents and per-file facts are cached by mtime and size.
  - `scanDirectory` returns the same array while nothing changed, and the import graph, resolver, call edges, routes and client calls are memoized on it.
  - The parse cache was a 5,000-entry first-in-first-out cache, so any pass over more files missed on every entry and re-parsed everything. It is now least-recently-used and covers 60,000 files.
  - The server warms the index and call edges in the background after the handshake.
- **Search.** Term frequencies, document frequencies, kinds and defined names are precomputed per chunk instead of per query. Results on the 104-question benchmark are unchanged (MRR 0.71, hit@5 84%).

Not done:
- 50k files measured only by extrapolation.
- No nightly CI job for the scale benchmark.
- Facts are not persisted between processes: a one-shot CLI command on a 10k repo that needs call edges still parses every file, taking about 13 s the first time.

---

## 6. Phase 3 — Cross-stack graph adapters (weeks 7–9)

The core of our differentiation: follow a request from the UI to the database.

### Request adapters (client side → server side)

Each adapter emits `http_edges` / `rpc_edges` with evidence:

| Adapter | Client pattern | Server pattern |
|---|---|---|
| Fetch wrappers | `api.delete(url)`, `client.get(...)`, custom helpers that call `fetch`/axios internally (resolved by following the helper's parameters to the `fetch` call) | Express, Fastify, Next.js route handlers (existing) |
| axios instances | `axios.create({ baseURL })` + instance calls | — |
| React Query / SWR | `useQuery({ queryFn })`, `useSWR(key, fetcher)` | — |
| Next.js server actions | importing a `'use server'` function into a client component | the action function itself |
| tRPC | `trpc.user.create.useMutation()` | `router({ user: router({ create: procedure... }) })` |
| GraphQL | `gql` documents / generated hooks | resolvers by type + field name |
| NestJS | — | `@Controller('keys')` + `@Delete(':id')` decorators |
| OpenAPI | generated clients (`operationId`) | spec file paths + handlers |

### Data-layer adapters

- Prisma (`schema.prisma` models, `prisma.apiKey.delete`), Drizzle (`pgTable` definitions + queries), TypeORM entities, raw SQL table names.
- Emit `data_edges` from functions to models/tables, so slices end at the schema.

**Done when:** on the benchmark repos, ≥80% of client requests are linked to a server handler (measured against a hand-labelled set), and flow traces reach the data layer.

**Status (core done):** adapters in `src/flow/adapters.ts` plus route extraction in `contractDrift.ts`:
- **Prisma:** `.prisma` schemas indexed; `db.<model>.<operation>()` → `data` edges to the model.
- **Drizzle:** `insert/update/delete/from(Table)` and `db.query.<Table>.findMany()` → `data` edges to `pgTable`-style definitions.
- **Dependency injection:** constructor parameter properties and typed fields; `this.svc.method()` → `Service.method`, `Repository<Entity>` / `Model<T>` → `data` edges.
- **Routes:** NestJS `@Controller` + `@Get…` (with `setGlobalPrefix`), FastAPI (`APIRouter(prefix=…)`), Flask `@route(methods=…)`, multi-line Express routes; Next.js `route.tsx` paths fixed.
- **tRPC:** client `trpc.<router>.<procedure>.<request op>()` → the procedure, through nested routers; procedure handlers are named `<router>.<procedure>`.
- **Clients:** fetch wrappers (first parameter passed into fetch/axios) and `axios.create({ baseURL })` instances.
- **Monorepos:** workspace packages resolved through `package.json` `exports` (pulled forward from Phase 2): schema impact in create-t3-turbo went from 1 direct / 0 transitive dependents to 4 / 25.

Measured (`npm run bench:links`): 18 of 18 request sites linked (100%; small sample — taxonomy 5, express 1, t3-turbo 12 tRPC calls); routes found 8 → 20 (Express) and 0 → 21 (NestJS); data-layer edges 0 → 96 across the corpus. Retrieval vs 1.4.0: hit@1 56% → 59%, MRR 0.69 → 0.70, feature recall@10 54% → 58%, and no ground-truth file is unindexed any more. Not yet done: GraphQL resolvers, OpenAPI clients, Express `app.use('/prefix', router)` mount prefixes, React Query / SWR `queryFn` indirection, and an independent hand-labelled linking set (the current check counts link coverage, not correctness).

---

## 7. Phase 4 — `feature_slice`: the flagship tool (weeks 9–10)

### Behaviour

Input: `{ feature: string, budget_tokens?: number (default 6000), include?: ("code"|"tests"|"docs"|"schema")[] }`

1. Seed with search (stemmed BM25 + optional embeddings).
2. Expand over the graph in both directions — callers up to entry points (pages, routes, CLI), callees down through HTTP/RPC edges to handlers, services and data models — scoring each node by distance, edge type and seed relevance.
3. Attach related tests (via imports) and docs (via mentions).
4. Pack into the budget: full snippets for the most relevant symbols, signatures/skeletons for the rest, references (`file:line`) for the tail.

Output (compact JSON):

```json
{
  "feature": "api key revocation",
  "layers": {
    "ui": [{ "file": "app/settings/keys/page.tsx", "symbol": "ApiKeysPage", "lines": "12-40", "why": "calls revokeApiKey" }],
    "client": [...], "server": [...], "data": [...], "auth": [...], "tests": [...]
  },
  "flow": ["ApiKeysPage → revokeApiKey → DELETE /api/keys/[id] → deleteApiKey → prisma.apiKey"],
  "snippets": [{ "file": "...", "lines": "...", "code": "..." }],
  "tokens": 4820,
  "omitted": [{ "file": "...", "reason": "budget" }]
}
```

**Done when:** on the `feature` question set, slice recall ≥0.85 with precision ≥0.6 inside 6k tokens, and tokens-to-answer at least 50% below grep-and-read.

**Status (core done, targets partly met):** `src/context/featureSlice.ts`, exposed as the `feature_slice` MCP tool (`feature`, `budget_tokens`, `include_tests`, `include_docs`) and `cb-trainer slice "<feature>" [--budget] [--tests] [--docs] [--json]`. Seeds come from search. Expansion is best-first over call, import, HTTP and data edges, up to callers or down to callees but never down-then-up, with hub and shared-UI damping and a penalty for seeds unconnected to the rest. Output is files grouped by layer, each with a one-line reason, plus flows, edges, signatures for every file that fits, snippets around the matched code and an `omitted` list. Defaults (16 files, 20 seed hits) were tuned on the dev split and confirmed on holdout. On all 24 feature questions:

| | Search, top 10 | `feature_slice`, one call |
|---|---|---|
| Recall of the labelled files | 59% | **83%** (dev 82%, holdout 84%) |
| Features fully covered | 17% (top 20) | **50%** |
| Median tokens | 7,506 (opening ranked files until all are found; answered questions only) | **4,552** (everything, packed) |
| Precision | — | 33% |

Recall misses 0.85 by two points, mostly on t3-turbo (61%: tRPC routers in a separate package rank low). Precision is well below 0.6. Part of that is the labels, which list the minimum file set, while the slice also returns mappers, auth helpers and models a change usually touches. But some of it is real noise from shared utilities. On this question set no setting reached both: precision peaks around 0.43, at 0.66 recall. So the default favours recall, because a missing file costs an agent another search while an extra signature costs a few dozen tokens. Not done yet: attaching related tests by import (`--tests` only admits tests that search or edges reach) and an `auth` layer (Phase 5).

---

## 8. Phase 5 — Permission map (weeks 11–12)

The check that would have caught the original `links:write` bug.

### Design

- **Auth adapters** extract the guard on each route: middleware chains (`app.use(requireAuth)`, Next.js `middleware.ts` matchers), guard calls (`requireScope('links:write')`, `assertRole('admin')`, `session.user.role === ...`), NestJS `@UseGuards` / custom decorators, tRPC `protectedProcedure`.
- **Output:** a matrix `route × method → { authenticated, scopes/roles, evidence }`, exposed as part of `api_map` and as a resource.
- **Findings** (also run by `review_diff` on changed routes):
  - `route-without-auth` — a route has no guard while sibling routes (same path prefix) do.
  - `method-scope-mismatch` — a destructive method (DELETE, or a handler that calls a delete on the data layer) is guarded by a read/write scope while siblings use a stronger one.
  - `scope-name-mismatch` — e.g. a scope named `*:read` guarding a mutating handler.
- Clearly labelled heuristics with evidence; never presented as a security audit.

**Done when:** a fixture reproducing the `links:write` scenario is flagged; false-positive rate measured on the benchmark repos and documented.

**Status (done):** `src/security/permissionMap.ts` maps every route to `required` / `optional` / `none` with its scopes, roles and the evidence (`file:line`) for each guard.

Guards are read from five places:
- Express middleware arguments and `router.use(...)`
- calls inside the handler (`requireScope('links:write')`, `verifyCurrentUserHasAccessToPost(id)`, `withScope(...)` wrappers, or a session read followed by a 401/403 or redirect)
- NestJS `@UseGuards` / `@Roles` / `@Public` and module `consumer.apply(AuthMiddleware).forRoutes(...)`
- Next.js `middleware.ts` matchers
- tRPC procedure builders (whether `protectedProcedure` rejects anonymous callers is read from its definition)

All three findings are implemented. The diff checker reports them as `permission-mismatch` when a diff touches a route handler. The map is exposed as `get_permission_map`, the `codebase://permissions` resource, a summary in `get_microservice_api_routes`, and `cb-trainer permissions`. Next.js handlers written as `export const DELETE = withScope(...)` are now recognised as routes.

The `links:write` fixture is flagged as `method-scope-mismatch`:
- **info** when no other route uses a separate delete scope
- **warning** when other routes do (e.g. `keys:delete`)

Results against hand labels (`bench/permissions.json`, `npm run bench:permissions`):

| | Benchmark repos |
|---|---|
| Routes with the right auth requirement | 57 / 57 |
| Findings | 1 (0 false positives) |
| Real problem found | nestjs-realworld `DELETE /api/users/:slug` has no guard; any caller can delete any user |

Limits:
- **Small, easy sample.** The labels were written by the same author as the tool.
- **Scope rules not exercised on real code.** None of these repos uses scopes, so only `route-without-auth` was tested here; the scope rules are covered by fixtures alone.
- **Regex fallback.** It finds only 24 of the routes (multi-line Express and NestJS decorators need the syntax tree).
- **Guards it can't see.** Guards applied where a router is mounted (`app.use('/admin', requireAdmin, router)`) and checks inside named handlers defined in other files.
- **Not done:** an `auth` layer in `feature_slice`.

---

## 9. Phase 6 — Test impact and optional embeddings (weeks 12–14)

### Test impact (`impact` tool, `tests` field)

Given a target or a diff: tests that import the changed code (transitively), plus tests whose names mention changed symbols; output a ready-to-run command (`npx vitest run a.test.ts b.test.ts`) for detected runners (vitest, jest, node:test, pytest).

**Status (test impact done):** `src/graph/testImpact.ts` selects tests for a list of files or symbols, or for a diff. A test is selected for one of three reasons:
- it is the changed file;
- it imports the change, directly or through other modules and test helpers (with the import chain given as the reason);
- it names a changed file or exported symbol, which catches tests that reach the code only at runtime.

It groups the tests by package and runner and gives a ready-to-run command for each: vitest, jest, node:test (plain or via tsx), mocha, playwright or pytest, with `cd <package>` in monorepos. It is exposed in three places:
- a `tests` field on `impact_analysis` / `cb-trainer impact`;
- `testsToRun` on `check_diff_against_standards` / `cb-trainer review`;
- `cb-trainer tests [targets...] [--base] [--commands]`, which by default uses the working-tree diff.

Measured by mutation on this repo (`npm run bench:test-impact`): each of 44 source files was made to throw on load, and the whole suite was run each time.

| | |
|---|---|
| Failing tests selected (recall) | **220 / 220 (100%)** |
| Test files selected per change | 5.5 of 14 on average (about 60% of the suite skipped) |

Limits:
- **Over-selection.** It comes from type-only imports, as in `src/types/index.ts`. Those modules are erased at runtime, but a change there can still break type-checking, so selecting their tests is the conservative choice.
- **What load failures don't show.** They break every test that reaches the file, so this measures recall and reduction, not precision for behaviour changes.
- **Only one repo measured.** The benchmark repos' suites need their own dependencies installed, so their selections were spot-checked by hand rather than run.

### Optional neural embeddings

- `@huggingface/transformers` as an **optional** dependency; a small code-capable model (~25–35 MB, quantized ONNX) downloaded on first opt-in and cached.
- Enabled with `cb-trainer init --embeddings` or `embeddings: true` in config; vectors stored in SQLite; fused with BM25 using real Reciprocal Rank Fusion.
- Default stays zero-setup lexical search. README states plainly which mode is active.

**Done when:** embeddings mode shows a measured recall@5 gain on `locate` questions; without opt-in, nothing is downloaded.

**Status (done):** `src/semantic/neuralEmbeddings.ts`.

How it works:
- Off by default. A repo opts in with `cb-trainer embeddings enable` (or `init --embeddings`), or with `embeddings:` in `codebase-trainer.yaml`. `CODEBASE_TRAINER_EMBEDDINGS=0` turns it off.
- `@huggingface/transformers` 4.3.1 is an **optional peer dependency**, not an `optionalDependency`. npm installs optional dependencies by default, which would have added about 300 MB of ONNX runtime to every install. It is loaded by name at runtime, so builds and CI don't need it.
- The model is a quantized ONNX file, downloaded once into `~/.cache/codebase-trainer/models` and run on the CPU.
- Chunk vectors are stored in `.codebase/neural/` keyed by content hash, so only new or edited chunks are re-embedded. They go there, not into SQLite, because Phase 2 isn't done.
- Search fuses the lexical ranking and the neural ranking with real reciprocal rank fusion (k = 60, neural weight 0.5), then applies the code-over-docs kind weights.
- If the model can't load, or the index is encrypted (vectors would be stored unencrypted), search falls back to lexical and says why.

Model and weight were chosen on the dev split: MiniLM-L6 (23 MB), bge-small (34 MB), arctic-embed-xs (23 MB), jina-v2-small (32 MB), at weights 0.35, 0.5, 0.75 and 1.

| MiniLM-L6, weight 0.5 | dev: lexical → fused | holdout: lexical → fused | all 104: lexical → fused |
|---|---|---|---|
| Locate hit@5 | 82% → **95%** | 90% → 90% | 84% → **94%** |
| Locate hit@1 | 58% → 60% | 65% → 65% | 60% → 61% |
| Locate MRR | 0.69 → **0.74** | 0.75 → 0.77 | 0.71 → **0.75** |
| Feature recall@10 | 59% → **65%** | 60% → **66%** | 59% → **65%** |

The other three models scored 0.72–0.73 MRR on dev. On holdout, hit@5 doesn't improve: those 28 questions were already at 90%. MRR and feature recall do improve there.

Costs:
- Search latency roughly doubles, from 45–70 ms to 90–160 ms per query.
- First-time embedding takes 20–70 s per benchmark repo on this laptop's CPU.
- `feature_slice` still seeds from lexical search.

Tests stub the model, so they cover opt-in, caching, fusion and fallback without downloading anything.

---

## 10. Phase 7 — Product, tool surface and enterprise readiness (weeks 14–16, plus ongoing)

### 10.1 Consolidated MCP tool surface (17 → 8)

Agents choose tools by their descriptions; fewer, sharper tools get used correctly.

| 2.0 tool | Replaces | Purpose |
|---|---|---|
| `search` | `search_codebase`, `search_global_workspace` | Find code by words or symbol; `scope: repo|workspace` |
| `feature_slice` | `get_context_pack` (partly) | Everything a feature touches, budgeted |
| `trace_flow` | `trace_flow` | Ordered call path with evidence |
| `impact` | `impact_analysis` | Dependents, affected routes, tests to run |
| `review_diff` | `check_diff_against_standards`, `generate_pr_review` | Findings with `file:line`; `format: json|markdown` |
| `api_map` | `get_microservice_api_routes`, `detect_api_drift` | Routes, clients, drift, permission matrix |
| `codebase_overview` | `get_codebase_conventions`, `visualize_architecture`, `generate_onboarding_guide`, `analyze_codebase_quality`, `get_model_health_status` | Conventions with evidence, architecture, hotspots |
| `quality_scan` | `scan_security_vulnerabilities`, `scan_code_duplication`, `get_tech_debt_items` | Security, duplication, debt, cycles |

Old names stay as deprecated aliases through 2.x, logged once per session.

### 10.2 Token discipline (applies to every tool)

- Every tool accepts `budget_tokens` and returns `tokens` used plus `omitted` items.
- `detail: "refs" | "signatures" | "snippets"` — default to the cheapest level that answers the question.
- Stable IDs for symbols so agents can request more detail without repeating the search.
- No boilerplate blocks (conventions, file lists) unless requested — as already done for search in 1.4.0.

### 10.3 Setup and configuration

- `npx codebase-trainer setup` — detects Claude Code, Cursor, VS Code, Windsurf; writes the MCP config; runs the first index; prints a 3-line "try this" prompt.
- `.codebase/config.yaml` (committable): include/exclude globs, precision mode, embeddings on/off, adapters to enable, custom auth guard names, budget defaults.
- Team sharing: `conventions.yaml` and config are committable; indexes are not.

### 10.4 Enterprise readiness

- **Offline guarantee:** no network calls except the opt-in model download; documented and tested (CI test with network disabled).
- **No telemetry.** Optional local usage log only, for the user's own tuning.
- Scales to 50k+ files (Phase 2 budgets extended to a 50k synthetic repo in CI nightly).
- Monorepo/workspace support (Phase 2), Windows/macOS/Linux parity (Phase 0 CI).
- Supply chain: pinned dependencies, npm provenance on release (already in `release.yml`), SBOM in release assets, signed tags.
- CI integration: `cb-trainer review --base main --format sarif` for code scanning; GitHub Action updated to use the published package instead of `dist/` paths.

### 10.5 Documentation and launch

- Docs site pages: quick start, how it works (honest limits), tool reference with example outputs, benchmark results with methodology.
- Launch with the benchmark table, including categories where we lose.

**Status (core done):**

- **10.1 Tool surface.** 20 tools became the eight above (`src/mcp/tools.ts`). Every 1.x name still works through an alias that logs one deprecation note per session. `get_context_pack` keeps its own output for existing prompts.
- **10.2 Token budgets.**
  - Every tool takes `budget_tokens` (default 8,000, or `budgets.defaultTokens`) and reports `budget.tokens`.
  - Over budget, the costliest lists are cut from the end and listed under `budget.omitted`.
  - `search` takes `detail: refs | snippets`.
  - `feature_slice` keeps its own packing.
  - Not done: stable symbol IDs for follow-up requests.
- **10.3 Setup and config.**
  - `cb-trainer setup` registers the server for each detected client: Claude Code `.mcp.json`, Cursor `.cursor/mcp.json`, VS Code `.vscode/mcp.json`, and Windsurf's per-user file only when named.
  - It merges into existing files without touching other servers and skips files it can't parse. `--dry-run` shows what it would write. It then builds the first index and prints prompts to try.
  - Shared settings live in `codebase-trainer.yaml` at the repo root rather than `.codebase/config.yaml`, because `.codebase/` is usually gitignored; the old path is still read. Settings: `exclude` globs, `embeddings`, `auth.guards` / `auth.publicPaths` for the permission map, and `budgets`. Unknown or invalid settings produce warnings, not errors.
- **10.4 Enterprise.**
  - `tests/offline.test.ts` runs all eight tools with sockets, DNS and fetch stubbed to fail, and asserts no attempt was made.
  - `cb-trainer review --format sarif --output f.sarif` is available.
  - `action.yml` now runs the published package through `npx` (it used to call `dist/`, which only exists in this repo), takes `base`, writes SARIF, and passes inputs through environment variables so they can't inject shell.
  - There is no telemetry.
  - Not done: 50k-file scale (needs Phase 2), SBOM and signed tags, and a `v1` tag for the action (the README's usage line assumes one).
- **10.5 Docs.** The README covers setup, the tool table, the config file and CI. Not done: a docs site and the launch.

---

## 11. Release plan

| Version | Contents | Breaking? |
|---|---|---|
| 1.5.0 | Phase 0: benchmark, `node:test`, 3-OS CI, published numbers | No |
| 1.6.0 | Phase 1: tree-sitter extraction (regex fallback), intra-file calls, signature-change check | No |
| 1.7.0 | Phase 2: SQLite store + server mode + monorepo resolution (JSON fallback where `node:sqlite` is unavailable) | No |
| 1.8.0 | Phase 3: request and data-layer adapters | No |
| 2.0.0 | `feature_slice`, permission map, consolidated 8-tool surface (old names aliased), config file, `setup` command, Node 22+ | Yes (tool names, Node floor) |
| 2.1.0 | Test impact, optional embeddings | No |

Each release must include its benchmark delta in the release notes.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tree-sitter grammars increase package size | Load grammars lazily; ship the 5 core languages; others as optional add-on packages |
| `node:sqlite` stability across Node versions | `Store` interface with JSON fallback; integration tests on Node 22 and 24 |
| Adapters are framework-specific and break with framework changes | Each adapter has its own fixture tests; adapters report what they matched so gaps are visible |
| Permission heuristics produce false positives | Labelled as heuristics with evidence; measured false-positive rate; per-repo config for custom guard names |
| Benchmark overfitting | Held-out question set per repo that is not used during development; add new repos each release |
| Scope creep toward "beat everyone" | §2 lists what we will not build; new features need a benchmark question set first |

---

## 13. Immediate next steps

1. Create `bench/` with the harness, pin the 4 corpus repos, and label the first 25 `locate` + 10 `feature` questions per repo.
2. Run v1.4.0 and a grep baseline; publish the first table in the README.
3. Migrate tests to `node:test` with fixture repos; enable the 3-OS CI matrix.
4. Start the tree-sitter spike on TypeScript/TSX and compare extraction accuracy against the regex extractor on the benchmark repos.
