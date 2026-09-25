// Tool Data Dictionary
const mcpToolsData = {
  get_codebase_conventions: {
    tag: "MCP PROTOCOL TOOL",
    desc: "Fetch structural rules, conventions, git norms, and custom guidelines learned for this codebase.",
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
  }
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
  search_codebase: {
    tag: "OKAPI BM25 SEARCH",
    desc: "Perform semantic vector search across indexed code chunks, symbols, and conventions with TF-IDF scoring.",
    json: `{
  "query": "BM25 ranking formula",
  "hits": [
    {
      "filePath": "src/semantic/searchEngine.ts",
      "startLine": 83,
      "endLine": 120,
      "score": 4.82,
      "snippet": "public static search(repoPath: string, query: string): SearchResult[]..."
    }
  ]
}`
  },
  search_global_workspace: {
    tag: "MULTI-REPO INDEX",
    desc: "Search across all 12 trained workspace microservice projects in parallel.",
    json: `{
  "query": "jwt auth middleware",
  "globalResults": [
    { "repo": "XtraSecurity", "file": "src/auth/jwt.ts", "score": 5.1 },
    { "repo": "XtraPass", "file": "src/vault/session.ts", "score": 4.6 }
  ]
}`
  },
  get_change_impact_analysis: {
    tag: "CALL GRAPH IMPACT",
    desc: "Trace downstream routes, callers, and modules at risk of breaking before editing code.",
    json: `{
  "target": "astExtractor.ts",
  "affectedRoutes": ["src/cli/index.ts", "src/mcp/server.ts", "src/miner/conventionMiner.ts"],
  "breakingRiskScore": "MEDIUM"
}`
  },
  scan_security_vulnerabilities: {
    tag: "STATIC SECURITY SCAN",
    desc: "Scan for hardcoded secrets, JWT keys, unsafe eval()/exec(), and SQL injection risks.",
    json: `{
  "status": "SECURE",
  "findings": [],
  "scannedFiles": 30,
  "vulnerabilityScore": "100/100"
}`
  },
  analyze_codebase_quality: {
    tag: "QUALITY & COMPLEXITY",
    desc: "Detect circular imports, high cyclomatic complexity, and synchronous I/O executed inside loops.",
    json: `{
  "mappedNodes": 17,
  "qualityIssues": [
    {
      "type": "sync_io_hotpath",
      "filePath": "src/graph/callGraph.ts",
      "line": 37,
      "severity": "warning"
    }
  ]
}`
  },
  get_agent_context_pack: {
    tag: "ZERO-OVERHEAD CONTEXT PACK",
    desc: "Generate pre-digested zero-overhead AI context pack containing rules, warnings, and top code snippets.",
    json: `{
  "task": "Refactor auth middleware",
  "conventionsSummary": "ESM named exports, explicit typing required",
  "topSnippets": ["src/mcp/server.ts#L195-L235"],
  "impactWarnings": ["Modifying server.ts affects 4 CLI handlers"]
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
  // Preloader Countdown Animation
  const preloader = document.getElementById('preloader');
  const progressBar = document.getElementById('progressBar');
  const progressNumber = document.getElementById('progressNumber');

  let progress = 0;
  const interval = setInterval(() => {
    progress += Math.floor(Math.random() * 15) + 5;
    if (progress >= 100) {
      progress = 100;
      clearInterval(interval);
      setTimeout(() => {
        if (preloader) preloader.classList.add('fade-out');
      }, 300);
    }
    if (progressBar) progressBar.style.width = `${progress}%`;
    if (progressNumber) progressNumber.textContent = `${progress}%`;
  }, 40);

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
    item.addEventListener('click', () => {
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
    });
  });

  // IDE Config Generator Tabs
  const ideTabs = document.querySelectorAll('.ide-tab');
  const configPath = document.getElementById('configPath');
  const configJsonDisplay = document.getElementById('configJsonDisplay');
  const copyConfigBtn = document.getElementById('copyConfigBtn');

  ideTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      ideTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const ideKey = tab.getAttribute('data-ide');
      const cfg = ideConfigs[ideKey];
      if (cfg && configPath && configJsonDisplay) {
        configPath.textContent = cfg.path;
        configJsonDisplay.textContent = cfg.json;
      }
    });
  });

  if (copyConfigBtn && configJsonDisplay) {
    copyConfigBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(configJsonDisplay.textContent);
      copyConfigBtn.textContent = 'COPIED!';
      setTimeout(() => copyConfigBtn.textContent = 'COPY JSON', 2000);
    });
  }

  // Documentation Hub Tab Switcher
  const docsTabs = document.querySelectorAll('.docs-nav-tab');
  const docsPanes = document.querySelectorAll('.docs-pane');

  docsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      docsTabs.forEach(t => t.classList.remove('active'));
      docsPanes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetTab = tab.getAttribute('data-docstab');
      const targetPane = document.getElementById(`pane-${targetTab}`);
      if (targetPane) {
        targetPane.classList.add('active');
      }
    });
  });
});

