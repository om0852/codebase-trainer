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

## 🌟 Features

1. **Token-Budgeted Code Skeletons (`--max-tokens`)**: Compresses code into structural skeletons that keep classes, function signatures, interfaces and docstrings while replacing function bodies with placeholders.
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

# 4. Generate AI Agent Token-Budgeted Context Pack
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
