# Codebase Trainer 🚀

> **Fast, local, per-codebase intelligence index and NLP convention model for AI IDEs & Agents.**

`codebase-trainer` (`cb-trainer`) prevents AI coding agents (Claude Code, Cursor, Antigravity IDE) from repeatedly grepping source files to re-discover project conventions. It extracts AST facts, mines code & git conventions into `.codebase/conventions.yaml`, builds a local semantic vector search index (`.codebase/embeddings.json`), maps symbol call graphs, scans security vulnerabilities, and serves them via standard **Model Context Protocol (MCP)** or CLI.

---

## 🌟 Major Engine Upgrades Implemented

1. **Industry-Standard Okapi BM25 Search Algorithm**: Replaced naive substring TF-IDF with true Okapi BM25 ranking algorithm (`k1 = 1.2`, `b = 0.75`) for sub-50ms high-precision search across 49,000+ code chunks.
2. **Static Vulnerability & Hardcoded Secret Scanner (`cb-trainer security`)**: Detects hardcoded API keys, JWT secrets, unsafe `eval()` / `new Function()` dynamic executions, and SQL injection risks.
3. **Multi-Language AST Extractor**: Supports TypeScript, JavaScript, Python, Go, Rust, Java, C/C++.
4. **Architectural Intent Classifier**: Automatically maps files into architectural roles (`controller_route`, `data_model`, `service_business_logic`, `ui_component`, `utility_helper`).
5. **Reverse Downstream Impact Analyzer (`cb-trainer impact <file>`)**: Traces direct & transitive dependents to warn developers and AI agents before committing breaking route/symbol changes.
6. **Automated PR Code Reviewer (`cb-trainer pr-review`)**: Generates automated PR review markdown reports (`.codebase/pr_review.md`) with policy and convention enforcement checks.
7. **Developer Onboarding Guide (`cb-trainer docs`)**: Generates `.codebase/ONBOARDING.md` summarizing architecture and conventions.
8. **Interactive HTML Dashboard (`cb-trainer ui`)**: Generates a sleek dark-mode visual dashboard (`.codebase/dashboard.html`).
9. **Auto-Fixer Engine (`cb-trainer fix <file>`)**: Automatically converts explicit `: any` to `: unknown` and legacy `var` to `const`.

---

## 🛠️ Complete CLI Suite

```bash
# 1. Initialize Codebase Intelligence Model & BM25 Index
npx cb-trainer init

# 2. Perform Okapi BM25 Semantic Vector Search
npx cb-trainer search "user authentication token"

# 3. Static Vulnerability & Hardcoded Secret Scan
npx cb-trainer security

# 4. Multi-Repo Workspace Master Initialization & Cross-Search
npx cb-trainer global-init
npx cb-trainer global-search "sentiment authentication token"

# 5. Check Downstream Breaking Change Impact
npx cb-trainer impact src/routes/user.ts

# 6. Generate Automated PR Review Report
npx cb-trainer pr-review

# 7. Generate Developer Onboarding Manual
npx cb-trainer docs

# 8. Digest AI Agent Zero-Overhead Context Pack
npx cb-trainer context "user login authentication"

# 9. Audit Call-Graph Dependencies & Code Quality
npx cb-trainer audit

# 10. Open Interactive HTML Dashboard
npx cb-trainer ui

# 11. Run 1,000-Query Stress Test Benchmark
npx cb-trainer benchmark

# 12. Run Unit Test Suite
npx tsx tests/unit.test.ts

# 13. Launch MCP Stdio Server
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

ISC
