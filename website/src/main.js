import { initCrosshair } from './crosshair.js';

// Tool Data Dictionary
const mcpToolsData = {
  get_codebase_conventions: {
    tag: "MCP PROTOCOL RESOURCE & TOOL",
    desc: "Fetch structural rules, conventions, git norms, and formatting guidelines mined from the repo AST.",
    json: `{
  "codebaseName": "codebase-trainer",
  "rules": {
    "structural": {
      "constantsPlacement": "top",
      "exportStyle": "named",
      "typeAnnotationRequirement": true
    },
    "git": {
      "commitFormat": "Conventional Commits (feat, fix, docs)",
      "branchNaming": "feature/*, fix/*"
    }
  },
  "resourceUri": "codebase://conventions"
}`
  },
  trace_execution_flow: {
    tag: "DYNAMIC SEQUENCE TOOL",
    desc: "Generate step-by-step execution flow and dynamic Mermaid sequence diagram for how a feature or architecture works.",
    json: `{
  "query": "E2EE encryption flow",
  "steps": [
    { "stepNumber": 1, "title": "Phase 1: Entrypoint (server.ts)", "lineRange": "L25-L35" },
    { "stepNumber": 2, "title": "Phase 2: HKDF Key Manager (keys.ts)", "lineRange": "L12-L28" },
    { "stepNumber": 3, "title": "Phase 3: AES-256-GCM Cipher (cipher.ts)", "lineRange": "L40-L65" }
  ],
  "mermaidDiagram": "sequenceDiagram\\n  autonumber\\n  actor Client\\n  Client->>server_ts: 1. Initiate query\\n  server_ts->>keys_ts: 2. Derive key\\n  keys_ts->>cipher_ts: 3. Encrypt payload"
}`
  },
  detect_api_drift: {
    tag: "CROSS-SERVICE CONTRACT VALIDATOR",
    desc: "Scan frontend API client calls (fetch/axios) against backend route schemas, flagging 404s, method mismatches, and payload drift.",
    json: `{
  "scannedClientCalls": 24,
  "scannedServerEndpoints": 32,
  "healthStatus": "DRIFT_DETECTED",
  "issues": [
    {
      "type": "PARAM_MISMATCH",
      "severity": "high",
      "clientFile": "website/src/api.ts",
      "endpoint": "/api/v1/auth/token",
      "details": "Client payload missing required field 'refreshToken'"
    }
  ],
  "resourceUri": "codebase://drift"
}`
  },
  get_agent_context_pack: {
    tag: "TOKEN-BUDGETED SKELETON PACK",
    desc: "Generate pre-digested AI context pack with token budgeting (--max-tokens) and automatic AST skeletonization (52%–85% token reduction).",
    json: `{
  "task": "Refactor auth middleware and route guards",
  "tokenBudget": 8000,
  "estimatedTokens": 3240,
  "skeletonizedFiles": [
    { "file": "src/mcp/server.ts", "compressionRatio": "68%", "preservedInterfaces": 14 }
  ],
  "conventionsSummary": "ESM named exports, explicit typing required",
  "impactWarnings": ["Modifying server.ts affects 4 CLI handlers"]
}`
  },
  search_codebase: {
    tag: "HYBRID RRF VECTOR SEARCH",
    desc: "Execute reciprocal rank fusion combining Okapi BM25, 128D local subword dense embeddings, AST symbols, and PageRank centrality.",
    json: `{
  "query": "PageRank power iteration algorithm",
  "fusionMode": "RRF (BM25 + 128D Dense + PageRank)",
  "hits": [
    {
      "filePath": "src/graph/pageRank.ts",
      "startLine": 45,
      "endLine": 98,
      "score": 0.942,
      "snippet": "export function computePageRank(graph: DependencyGraph): Map<string, number>..."
    }
  ]
}`
  },
  get_change_impact_analysis: {
    tag: "DIFF-AWARE BLAST RADIUS",
    desc: "Trace caller dependency trees, downstream routes, and calculate breaking risk scores before committing code.",
    json: `{
  "target": "astExtractor.ts",
  "affectedRoutes": ["src/cli/index.ts", "src/mcp/server.ts", "src/miner/conventionMiner.ts"],
  "downstreamDependentsCount": 7,
  "breakingRiskScore": "MEDIUM"
}`
  },
  scan_security_vulnerabilities: {
    tag: "ZERO-CLOUD STATIC SCAN",
    desc: "Zero-cloud static analysis detecting exposed API keys, JWT secrets, unsafe eval()/exec(), and SQL injection vulnerabilities.",
    json: `{
  "status": "SECURE",
  "findings": [],
  "scannedFiles": 48,
  "vulnerabilityScore": "100/100",
  "sarifExport": ".codebase/results.sarif"
}`
  },
  analyze_codebase_quality: {
    tag: "PAGERANK & ARCHITECTURE AUDIT",
    desc: "Evaluate module centrality, detect circular dependency cycles, high cyclomatic complexity, and synchronous I/O on hot paths.",
    json: `{
  "mappedNodes": 34,
  "circularDependencies": [],
  "topHubModules": [
    { "file": "src/semantic/searchEngine.ts", "pageRank": 0.184 },
    { "file": "src/storage/db.ts", "pageRank": 0.162 }
  ],
  "resourceUri": "codebase://graph/quality"
}`
  },
  search_global_workspace: {
    tag: "MULTI-REPO INDEX",
    desc: "Search across all trained workspace microservice projects in parallel.",
    json: `{
  "query": "jwt auth middleware",
  "globalResults": [
    { "repo": "XtraSecurity", "file": "src/auth/jwt.ts", "score": 5.1 },
    { "repo": "XtraPass", "file": "src/vault/session.ts", "score": 4.6 }
  ]
}`
  }
};

// IDE Config Templates
const ideConfigs = {
  cursor: {
    path: "Cursor IDE -> Settings -> Features -> MCP -> Add New MCP Server",
    json: `{
  "mcpServers": {
    "codebase-trainer": {
      "command": "npx",
      "args": ["-y", "codebase-trainer", "mcp"]
    }
  }
}`
  },
  antigravity: {
    path: "Antigravity IDE -> %USERPROFILE%\\.gemini\\config\\mcp_config.json",
    json: `{
  "mcpServers": {
    "codebase-trainer": {
      "$typeName": "exa.cascade_plugins_pb.CascadePluginCommandTemplate",
      "command": "npx",
      "args": ["-y", "codebase-trainer", "mcp"],
      "env": {}
    }
  }
}`
  },
  claude: {
    path: "Claude Desktop -> %APPDATA%\\Claude\\claude_desktop_config.json",
    json: `{
  "mcpServers": {
    "codebase-trainer": {
      "command": "npx",
      "args": ["-y", "codebase-trainer", "mcp"]
    }
  }
}`
  },
  vscode: {
    path: "VS Code -> settings.json (MCP Extension)",
    json: `{
  "mcp.servers": {
    "codebase-trainer": {
      "command": "npx",
      "args": ["-y", "codebase-trainer", "mcp"]
    }
  }
}`
  }
};

document.addEventListener('DOMContentLoaded', () => {
  // Initialize React Bits Crosshair cursor animation
  initCrosshair({
    color: '#00f2ff',
    thickness: 1,
    opacity: 0.85,
    lineStyle: 'solid',
    gap: 4,
    fade: 0.15,
    smoothing: 0.35,
    showCoordinates: true,
    targetEffect: 'lock',
    targetSelector: 'a, button, [data-crosshair-target], .btn-outline, .btn-primary, .nav-item, .ide-tab, .docs-nav-tab, .tool-nav-item, .code-snippet, .stat-card, .metric-pill, .interactive-card, .brand-logo',
    clickPulse: true,
    hideCursor: false,
    blendMode: 'normal'
  });

  // Preloader Complete Instantly
  const preloader = document.getElementById('preloader');
  if (preloader) preloader.style.display = 'none';

  // Copy Hero Command
  const copyCmdBtn = document.getElementById('copyCmdBtn');
  if (copyCmdBtn) {
    copyCmdBtn.addEventListener('click', () => {
      navigator.clipboard.writeText('npx codebase-trainer init');
      const span = copyCmdBtn.querySelector('span');
      if (span) {
        span.textContent = 'COPIED';
        setTimeout(() => span.textContent = 'COPY', 2000);
      }
    });
  }

  // Tool Navigation Switcher
  const toolItems = document.querySelectorAll('.tool-nav-item');
  const activeToolName = document.getElementById('activeToolName');
  const activeToolTag = document.getElementById('activeToolTag');
  const activeToolDesc = document.getElementById('activeToolDesc');
  const activeToolJson = document.getElementById('activeToolJson');

  toolItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const currentScrollY = window.scrollY;

      toolItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      const toolKey = item.getAttribute('data-tool');
      const data = mcpToolsData[toolKey];
      if (data && activeToolName) {
        activeToolName.textContent = toolKey;
        activeToolTag.textContent = data.tag;
        activeToolDesc.textContent = data.desc;
        activeToolJson.textContent = data.json;
      }

      window.scrollTo({ top: currentScrollY, behavior: 'instant' });
    });
  });

  // IDE Config Generator Tabs
  const ideTabs = document.querySelectorAll('.ide-tab');
  const configPath = document.getElementById('configPath');
  const configJsonDisplay = document.getElementById('configJsonDisplay');
  const copyConfigBtn = document.getElementById('copyConfigBtn');

  ideTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      const currentScrollY = window.scrollY;

      ideTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const ideKey = tab.getAttribute('data-ide');
      const cfg = ideConfigs[ideKey];
      if (cfg && configPath && configJsonDisplay) {
        configPath.textContent = cfg.path;
        configJsonDisplay.textContent = cfg.json;
      }

      window.scrollTo({ top: currentScrollY, behavior: 'instant' });
    });
  });

  if (copyConfigBtn && configJsonDisplay) {
    copyConfigBtn.addEventListener('click', (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(configJsonDisplay.textContent);
      copyConfigBtn.textContent = 'COPIED!';
      setTimeout(() => copyConfigBtn.textContent = 'COPY JSON', 2000);
    });
  }

  // Documentation Hub Tab Switcher
  const docsTabs = document.querySelectorAll('.docs-nav-tab');
  const docsPanes = document.querySelectorAll('.docs-pane');

  docsTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      const currentScrollY = window.scrollY;

      docsTabs.forEach(t => t.classList.remove('active'));
      docsPanes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetTab = tab.getAttribute('data-docstab');
      const targetPane = document.getElementById(`pane-${targetTab}`);
      if (targetPane) {
        targetPane.classList.add('active');
      }

      window.scrollTo({ top: currentScrollY, behavior: 'instant' });
    });
  });
});

