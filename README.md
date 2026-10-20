# Codebase Trainer 🚀

> **Fast, local, per-codebase intelligence index and NLP convention model for AI IDEs & Agents.**

`codebase-trainer` (`cb-trainer`) prevents AI coding agents (Claude Code, Cursor, Antigravity IDE) from repeatedly grepping source files to re-discover project conventions. It extracts AST facts, mines code & git conventions into `.codebase/conventions.yaml`, builds a local semantic vector search index (`.codebase/embeddings.json`), maps symbol call graphs, scans security vulnerabilities, and serves them via standard **Model Context Protocol (MCP)** or CLI.

---

## 🌟 Major Features & v1.3.0 Upgrades

1. **Token-Budgeted AST Skeletonizer (`--max-tokens`)**: Compresses code by 50%–85% into structural AST skeletons—preserving classes, function signatures, interfaces, and docstrings while stripping function bodies into placeholders (`/* ... */` or `pass`).
2. **Client ↔ Server API Contract Drift Detector (`cb-trainer drift`)**: Automatically parses frontend `fetch()` / `axios` calls and backend Express/Next.js route handlers, flagging payload key mismatches, missing required fields, dead endpoints, and orphan routes.
3. **PageRank-Weighted Graph Centrality (Aider Style)**: Implements Power Iteration PageRank over module dependencies and call graphs. Core architectural hubs receive boosted ranking over peripheral one-off scripts.
4. **100% Offline Dense Vector Embeddings**: Pure local semantic vector embedding engine with cosine similarity and hybrid Reciprocal Rank Fusion (BM25 + Dense Vectors + AST Symbols + PageRank).
5. **Interactive Mermaid Architecture Dashboard (`cb-trainer ui`)**: Generates an interactive dark-mode dashboard with zoomable Mermaid module call graphs and visual circular dependency highlights.
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

# 10. Generate Automated PR Review Report
npx cb-trainer pr-review

# 11. Run Unit Test Suite
npm test

# 12. Launch MCP Stdio Server
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

---

## 📄 License

MIT
