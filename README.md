# Codebase Trainer 🚀

> **Fast, local, zero-setup codebase index and context tools for AI coding agents.**

`codebase-trainer` (`cb-trainer`) gives AI coding agents (Claude Code, Cursor, and other MCP clients) a local map of a repository so they stop re-grepping it: code search, execution-flow traces, change impact, a diff checker, and conventions learned from the code, served over the **Model Context Protocol (MCP)** or the CLI. It runs fully offline with no API keys, vector database, or language servers.

**How it works, honestly:** source files are analysed with pattern-based (regex) extractors, not a compiler or language server. That keeps it dependency-free and fast, and works best on JavaScript/TypeScript; Python is partially supported and Go/Java/Rust only lightly. Tools report what they could not determine (`pathFound: false`, `notCovered`, `evidence`, `stale`) rather than guessing.

---

## 🆕 What's new in 1.4.0

- **Import graph that actually resolves imports**: ES module imports (previously missed entirely), `tsconfig`/`jsconfig` path aliases, `.js` → `.ts`, index files, Python/Java/Rust modules. PageRank, impact analysis and cycle detection now run on it.
- **Execution-flow tracing from real call sites**: entry points (pages, route handlers, CLI commands) → calls with `file:line` evidence → `fetch('/api/…')` linked to the matching route handler → data layer. Returns `pathFound: false` instead of inventing a path.
- **Diff checker on real git diffs** (`check_diff_against_standards`, `cb-trainer review`): secrets, security risks, removed exports still imported elsewhere, API contract drift, and convention checks, each with `file:line`, plus the list of what it does not check.
- **Search**: stemming (resolve/resolver/resolution), question words ignored, code ranked above tests and docs, compact agent output, automatic refresh of changed files before every search, `.gitignore` honoured.
- **Conventions learned from the code** with the counts behind each value (`evidence`), plus role counts for pages, routes, hooks, stores and middleware.
- **Real duplication scan and module dependency diagram** (`cb-trainer duplicates`, `cb-trainer architecture`).

## 📏 Benchmark

104 hand-labelled questions ("where is password reset implemented", "everything involved in favoriting an article") on four open-source apps pinned to exact commits: [taxonomy](https://github.com/shadcn-ui/taxonomy) (Next.js + Prisma), [node-express-realworld](https://github.com/gothinkster/node-express-realworld-example-app) (Express + Prisma), [nestjs-realworld](https://github.com/lujakob/nestjs-realworld-example-app) (NestJS + TypeORM) and [create-t3-turbo](https://github.com/t3-oss/create-t3-turbo) (tRPC monorepo). The baseline is what an agent does without an index: grep the question's words and open the files with the most matches.

| v1.4.0, all 104 questions | codebase-trainer | grep baseline |
|---|---|---|
| Right file ranked first ("locate", 80 questions) | **56%** | 24% |
| Right file in the top 5 | **83%** | 65% |
| Mean reciprocal rank | **0.69** | 0.43 |
| Median tokens read to reach the right file | **993** | 3,974 |
| Share of a feature's files in the top 10 ("feature", 24 questions) | **54%** | 40% |
| Features with every needed file in the top 20 | 17% | 0% |

Search takes 60–150 ms per query on these repos (100–170 files each). The 28 questions held out from tuning score the same as the rest (MRR 0.72 vs 0.37).

**Where it is still weak:** whole-feature questions (only 17% fully covered) and Prisma schemas, which are not indexed yet. Both are the next items on the [implementation plan](docs/IMPLEMENTATION_PLAN.md). Reproduce with `npm run bench:setup && npm run bench`; results are written to `bench/results/`.

## 🌟 Features

1. **Feature slices (`cb-trainer slice`, MCP `feature_slice`)**: One call returns the files a feature spans, grouped by layer (UI, client, route, service, data model), each with the reason it was included, the call/request/data flows between them, and code packed to a token budget. On the benchmark's 24 feature questions it finds 83% of the labelled files in about 4,500 tokens; the top 10 search results find 59%.
1. **Token-Budgeted Code Skeletons (`--max-tokens`)**: Compresses code into structural skeletons that keep classes, function signatures, interfaces and docstrings while replacing function bodies with placeholders.
1. **Permission map (`cb-trainer permissions`, MCP `get_permission_map`)**: Every route's auth requirement, scopes and roles with `file:line` evidence, read from Express middleware, handler checks, NestJS guards and module middleware, Next.js `middleware.ts` and tRPC procedures. It flags writes with no guard next to guarded siblings, deletes allowed by a scope that also grants editing, and read scopes guarding writes; the diff checker runs the same checks on changed routes. Heuristic, not a security audit: on the benchmark repos it classified 57 of 57 routes correctly and found one real unguarded delete with no false positives.
2. **Client ↔ Server API Contract Drift Detector (`cb-trainer drift`)**: Parses frontend `fetch()` / `axios` calls and Express / Next.js route handlers, flagging method and payload mismatches, dead endpoints and orphan routes.
3. **PageRank Graph Centrality (Aider style)**: Power-iteration PageRank over the resolved import graph, so central modules rank above one-off scripts.
4. **Hybrid Local Search**: BM25 over stemmed tokens, combined with exact-symbol matches, a hashed character-trigram similarity score, and PageRank. The similarity score is lexical (it catches spelling and word-part overlap, not synonyms); there is no neural embedding model.
5. **Interactive Mermaid Dashboard (`cb-trainer ui`)**: Dark-mode dashboard with module graphs and circular-dependency highlights.
6. **Live Dynamic MCP Resources**:
   - `codebase://conventions`: Project architecture rules and coding conventions.
   - `codebase://routes`: Live map of exposed REST endpoints and consumed services.
   - `codebase://drift`: Live client-to-server API contract drift status.
   - `codebase://graph/circular`: Real-time circular import warnings.
   - `codebase://graph/quality`: Call graph sync I/O alerts and hotspots.
7. **Official GitHub Action (`action.yml`)**: Pre-built GitHub Action for CI/CD pipelines to run contract drift checks, convention checks, and export SARIF static analysis reports to GitHub Code Scanning.

---

## 🛠️ Complete CLI Suite

```bash
# 1. Initialize Codebase Intelligence Model & Vector Index
npx cb-trainer init

# 2. Perform Hybrid Semantic Vector + PageRank Search
npx cb-trainer search "user authentication token"

# 3. Detect Client ↔ Server API Contract Drift & Payload Mismatches
npx cb-trainer drift

# 3b. Which routes require auth, with which scopes and roles, and where that looks wrong
npx cb-trainer permissions --findings-only

# 4. Everything needed to change one feature, across layers, in one call
npx cb-trainer slice "article comments" --budget 6000

# 4b. Generate AI Agent Token-Budgeted Context Pack
npx cb-trainer context "user login authentication" --max-tokens 1500

# 5. Trace End-to-End Execution Sequence Flow (Mermaid Sequence)
npx cb-trainer flow "user checkout order"

# 6. Check Downstream Breaking Change Impact
npx cb-trainer impact src/routes/user.ts

# 7. Static Vulnerability & Hardcoded Secret Scan
npx cb-trainer security

# 8. Open Interactive HTML Dashboard (Mermaid Call Graph)
npx cb-trainer ui

# 9. Audit Call-Graph Dependencies, Circular Imports & Hotpath I/O
npx cb-trainer audit

# 10. Check the Working-Tree Diff (secrets, broken imports, API drift, conventions)
npx cb-trainer review --base main

# 11. Generate Automated PR Review Report
npx cb-trainer pr-review

# 12. Find Duplicated Code Blocks (every copy's file:line range)
npx cb-trainer duplicates --min-lines 6

# 13. Module Dependency Diagram from Resolved Imports (Mermaid)
npx cb-trainer architecture

# 14. Run Unit Test Suite
npm test

# 15. Launch MCP Stdio Server
npx cb-trainer mcp
```

---

## 🔌 Connecting to AI IDEs via MCP

Add the following to your MCP client config (e.g. `mcp_config.json` in Cursor, Claude Code, or Antigravity):

```json
{
  "mcpServers": {
    "codebase-trainer": {
      "command": "node",
      "args": ["/path/to/codebase-trainer/dist/cli/index.js", "mcp"]
    }
  }
}
```

### Index freshness

Before every search, files on disk are compared with the stats recorded when they were indexed. Changed, new and deleted files are re-indexed in place, so results never come from code you have since edited. `search_codebase` returns an `index` block saying when the index was built and how many files were refreshed.

Set `CODEBASE_TRAINER_AUTO_REFRESH=0` to skip re-indexing; changed files are then listed under `staleFiles` and their results carry `"stale": true`.

The index covers files not excluded by the repo-root `.gitignore`, `.codebaseignore`, or the built-in list of dependency and build directories (`node_modules`, `dist`, `build`, `.next`, `vendor`, `target`, virtualenvs, caches).

---

## 📄 License

MIT
