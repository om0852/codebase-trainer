import { copyText, initShared } from './shared.js';

// Real responses from the published 2.0.0 package, run on the benchmark apps (shortened where marked)
const tools = {
  search: {
    tag: 'FIND CODE',
    desc: 'Ranked snippets labelled code, test, doc or config, with file:line. Keyword ranking (BM25 over stemmed words, exact symbols, PageRank) with code ranked first; fused with a local neural model when the repo opts in. scope: "workspace" searches sibling repos; detail: "refs" returns locations only.',
    prompt: '"Where are comments added to an article? Use codebase-trainer search."',
    source: 'search · node-express-realworld',
    json: `{
  "semanticResults": [
    {
      "filePath": "src/app/routes/article/article.controller.ts",
      "startLine": 152, "endLine": 163, "kind": "code", "score": 18.2,
      "snippet": "const comments = await getCommentsByArticle(req.params.slug, req.auth?.user?.id); …"
    },
    {
      "filePath": "src/app/routes/article/article.service.ts",
      "startLine": 476, "endLine": 487, "kind": "code", "score": 17.7,
      "snippet": "const comment = await prisma.comment.create({ …"
    }
  ],
  "mode": "lexical",
  "index": { "fullRebuild": false, "refreshedFiles": 0, "removedFiles": 0 },
  "budget": { "tokens": 348, "budgetTokens": 8000 }
}`
  },
  feature_slice: {
    tag: 'WHOLE FEATURE',
    desc: 'Everything one feature touches, across layers, within a token budget: each file with its layer and the reason it was included (a search match, or the edge that reached it), the flows between them, and signatures and snippets packed to the budget. Files that did not fit are listed under omitted.',
    prompt: '"Use codebase-trainer feature_slice for article favorites, then add a favorites count to the article page."',
    source: 'feature_slice · node-express-realworld (12 of 16 files shown)',
    json: `{
  "feature": "article favorites",
  "budgetTokens": 1500,
  "tokens": 1475,
  "files": [
    { "file": "src/app/routes/article/article.controller.ts", "layer": "server",
      "why": "search match", "symbols": ["POST /articles", "GET /articles"] },
    { "file": "src/app/routes/article/article.service.ts", "layer": "server",
      "why": "search match", "symbols": ["favoriteArticle", "unfavoriteArticle", "getArticle", "…"] },
    { "file": "src/prisma/schema.prisma", "layer": "data",
      "why": "search match", "symbols": ["Article", "Comment", "User"] },
    { "file": "src/app/routes/profile/profile.utils.ts", "layer": "server",
      "why": "favoriteArticle in src/app/routes/article/article.service.ts uses profileMapper" },
    { "file": "src/app/routes/article/author.mapper.ts", "layer": "server",
      "why": "articleMapper in src/app/routes/article/article.mapper.ts uses authorMapper" },
    …
  ],
  "flows": [
    "routes.ts → articlesController → addComment → HttpException",
    "routes.ts → articlesController → createArticle → HttpException",
    …
  ],
  "snippets": [ … 5 snippets … ],
  "omitted": [ … 4 lower-ranked files … ]
}`
  },
  trace_flow: {
    tag: 'EXECUTION PATH',
    desc: 'How a feature runs: entry points (pages, route handlers, CLI commands), then real call sites, client requests linked to the route handlers they hit, and data-layer calls, each with the line that proves it. Returns pathFound: false with related files rather than inventing a path, plus a Mermaid sequence diagram.',
    prompt: '"Trace how favoriting an article works, from the route to the database, with codebase-trainer trace_flow."',
    source: 'trace_flow · node-express-realworld (shortened)',
    json: `{
  "query": "favorite an article",
  "pathFound": true,
  "entryPoints": ["src/main.ts"],
  "edges": [
    { "kind": "reference", "from": { "filePath": "src/main.ts", "line": 16 },
      "to": { "filePath": "src/app/routes/routes.ts", "symbol": "routes" },
      "evidence": "app.use(routes);" },
    { "kind": "call", "from": { "filePath": "src/app/routes/article/article.controller.ts", "line": 215 },
      "to": { "filePath": "src/app/routes/article/article.service.ts", "symbol": "favoriteArticle", "line": 562 },
      "evidence": "const article = await favoriteArticle(req.params.slug, req.auth?.user?.id);" },
    { "kind": "data", "from": { "filePath": "src/app/routes/article/article.service.ts", "symbol": "getArticles", "line": 77 },
      "to": { "filePath": "src/prisma/schema.prisma", "symbol": "Article", "line": 11 },
      "evidence": "const articles = await prisma.article.findMany({",
      "label": "findMany Article" },
    …
  ],
  "mermaidDiagram": "sequenceDiagram\\n  participant article_controller …"
}`
  },
  impact: {
    tag: 'BEFORE YOU CHANGE IT',
    desc: 'Files that import the target (directly and transitively), other files that reference it, and the tests to run: tests that import it, reach it through other modules or helpers, or name it, with a ready-to-run command per test runner and package.',
    prompt: '"Before you edit article.service.ts, run codebase-trainer impact on it and tell me which tests to run."',
    source: 'impact · node-express-realworld (shortened)',
    json: `{
  "target": "src/app/routes/article/article.service.ts",
  "directDependents": [
    "src/app/routes/article/article.controller.ts",
    "src/prisma/seed.ts",
    "src/tests/services/article.service.test.ts"
  ],
  "transitiveDependents": ["src/app/routes/routes.ts", "src/main.ts"],
  "tests": {
    "files": [
      { "file": "src/tests/services/article.service.test.ts", "via": "import", "distance": 1,
        "reason": "imports src/app/routes/article/article.service.ts" }
    ],
    "commands": [
      { "runner": "jest", "cwd": ".", "command": "npx jest src/tests/services/article.service.test.ts" }
    ],
    "totalTests": 6
  },
  "budget": { "tokens": 361, "budgetTokens": 900 }
}`
  },
  review_diff: {
    tag: 'CHECK YOUR CHANGES',
    desc: 'Checks your git diff (working tree against HEAD, or a base branch, including untracked files) for secrets, risky code, removed exports still imported elsewhere, contract drift, permission problems on changed routes and convention breaks. Every finding has file:line. format: json, markdown (a PR comment) or sarif (code scanning). Always lists what it did not check.',
    prompt: '"Run codebase-trainer review_diff on my changes and fix anything it reports."',
    source: 'review_diff · node-express-realworld, after pasting a key into a file (shortened)',
    json: `{
  "status": "failed",
  "passed": false,
  "source": "git diff HEAD",
  "filesChecked": ["src/app/routes/profile/profile.utils.ts"],
  "findings": [
    {
      "ruleId": "hardcoded-secret",
      "severity": "error",
      "filePath": "src/app/routes/profile/profile.utils.ts",
      "line": 15,
      "message": "Hardcoded secret added (Stripe Secret Key). Move it to an environment variable or secret store, and rotate it if it was ever committed."
    }
  ],
  "summary": "1 error(s), 0 warning(s), 0 info across 1 changed file(s), 2 added line(s).",
  "notCovered": [
    "Authorization beyond the permission map: whether the user may act on this specific record, …",
    "Business rules, data validation and error handling",
    "…"
  ],
  "testsToRun": { "tests": [ … ], "commands": [ … ] }
}`
  },
  api_map: {
    tag: 'ROUTES · DRIFT · PERMISSIONS',
    desc: 'The HTTP API: routes served and called, client/server drift (method, path and payload mismatches), and the permission map: auth, scopes and roles per route with heuristic findings. section: all, routes, drift or permissions.',
    prompt: '"Use codebase-trainer api_map with section permissions and explain each finding."',
    source: 'api_map · nestjs-realworld (a real finding)',
    json: `{
  "summary": { "routes": 21, "required": 12, "optional": 0, "none": 9 },
  "findings": [
    {
      "rule": "route-without-auth",
      "severity": "warning",
      "method": "DELETE",
      "endpoint": "/api/users/:slug",
      "filePath": "src/user/user.controller.ts",
      "line": 38,
      "message": "DELETE /api/users/:slug has no auth guard, but 2 other route(s) on the same resource require one.",
      "evidence": [
        "GET /api/user (src/user/user.controller.ts:22) -> auth",
        "PUT /api/user (src/user/user.controller.ts:27) -> auth"
      ]
    }
  ],
  "notes": ["Heuristic: …", "Not a security audit: …"]
}`
  },
  codebase_overview: {
    tag: 'HOW THIS CODEBASE IS BUILT',
    desc: 'Conventions learned from the code with the evidence behind each (naming, exports, typing, docs, git), the module dependency diagram with import cycles, quality hotspots and index health. section: onboarding writes an onboarding guide.',
    prompt: '"Use codebase-trainer codebase_overview and summarise the conventions I should follow here."',
    source: 'codebase_overview · node-express-realworld (shortened)',
    json: `{
  "codebaseName": "express-realworld",
  "evidence": {
    "structural.typeAnnotationRequirement": "38 of 39 JS/TS files are TypeScript",
    "structural.namingConvention": "functions camelCase (100% of 29), file names kebab-case (100% of 9)",
    "structural.exportStyle": "12 named-only, 14 default-only, 0 both, of 26 JS/TS files with exports",
    "documentation.requireDocstrings": "0 of 21 exported JS/TS functions/classes have JSDoc"
  },
  "rules": {
    "structural": { "exportStyle": "mixed", "typeAnnotationRequirement": true },
    "git": { "commitFormat": "Conventional Commits (fix)" }
  },
  "architecture": { "roles": { "controller_route": { "count": 22 }, "data_model": { "count": 8 }, … } }
}`
  },
  quality_scan: {
    tag: 'SECURITY · DUPLICATION · DEBT · CYCLES',
    desc: 'Static scans with file:line: hardcoded secrets and risky code (eval/exec, SQL built from strings, disabled TLS checks), duplicated blocks, TODO/FIXME/HACK markers and circular imports. checks: any of security, duplication, debt, cycles.',
    prompt: '"Run codebase-trainer quality_scan for cycles and duplication and suggest what to clean up first."',
    source: 'quality_scan · node-express-realworld (cycles only)',
    json: `{
  "result": [
    {
      "type": "circular_dependency",
      "description": "Circular import dependency among 2 file(s): src/app/routes/article/article.model.ts, src/app/routes/article/comment.model.ts",
      "severity": "error"
    },
    …
  ],
  "budget": { … }
}`
  }
};

const server = { command: 'npx', args: ['-y', 'codebase-trainer', 'mcp'] };
const editors = {
  claude: {
    path: '.mcp.json — in the repository root, committed for your team',
    code: JSON.stringify({ mcpServers: { 'codebase-trainer': server } }, null, 2),
    note: 'Or run in the repo root: claude mcp add --scope project codebase-trainer -- npx -y codebase-trainer mcp'
  },
  cursor: {
    path: '.cursor/mcp.json — in the repository',
    code: JSON.stringify({ mcpServers: { 'codebase-trainer': server } }, null, 2),
    note: 'Or Cursor Settings → MCP → Add new server with the command npx -y codebase-trainer mcp.'
  },
  vscode: {
    path: '.vscode/mcp.json — in the repository (Copilot agent mode)',
    code: JSON.stringify({ servers: { 'codebase-trainer': { type: 'stdio', ...server } } }, null, 2),
    note: 'VS Code uses the "servers" key and needs "type": "stdio".'
  },
  windsurf: {
    path: '~/.codeium/windsurf/mcp_config.json — per user',
    code: JSON.stringify({ mcpServers: { 'codebase-trainer': server } }, null, 2),
    note: 'Or run npx codebase-trainer setup --client windsurf. The server indexes the folder it starts in, so open the repository as your workspace.'
  },
  global: {
    path: 'Any client · with a global install (faster start than npx)',
    code: 'npm install -g codebase-trainer\n\n# then use this server command in your client config:\n' + JSON.stringify({ command: 'cb-trainer', args: ['mcp'] }, null, 2),
    note: 'Upgrade later with npm install -g codebase-trainer@latest. Check the version with cb-trainer --version.'
  }
};

// Switch tabs without the page jumping to the clicked element
const tabs = (buttons, attribute, onSelect) => {
  buttons.forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    const y = window.scrollY;
    buttons.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    button.classList.add('active');
    button.setAttribute('aria-selected', 'true');
    onSelect(button.getAttribute(attribute));
    window.scrollTo({ top: y, behavior: 'instant' });
  }));
};

// Sidebar link for the section currently in view
function scrollSpy() {
  const links = new Map([...document.querySelectorAll('.docs-nav-link')].map(a => [a.getAttribute('href').slice(1), a]));
  const sections = [...document.querySelectorAll('.doc-section')];
  const update = () => {
    const line = window.innerHeight * 0.3;
    let current = sections[0]?.id;
    sections.forEach(s => { if (s.getBoundingClientRect().top <= line) current = s.id; });
    links.forEach((a, id) => a.classList.toggle('active', id === current));
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
}

document.addEventListener('DOMContentLoaded', () => {
  initShared();
  scrollSpy();

  // Tool explorer
  const showTool = key => {
    const tool = tools[key];
    if (!tool) return;
    document.getElementById('activeToolName').textContent = key;
    document.getElementById('activeToolTag').textContent = tool.tag;
    document.getElementById('activeToolDesc').textContent = tool.desc;
    document.getElementById('activeToolPrompt').textContent = tool.prompt;
    document.getElementById('activeToolSource').textContent = tool.source.toUpperCase();
    document.getElementById('activeToolJson').textContent = tool.json;
  };
  tabs(document.querySelectorAll('.tool-nav-item'), 'data-tool', showTool);
  showTool('search');

  // Editor config generator
  const configPath = document.getElementById('configPath');
  const configCode = document.getElementById('configJsonDisplay');
  const configNote = document.getElementById('configNote');
  const showEditor = key => {
    const editor = editors[key];
    if (!editor) return;
    configPath.textContent = editor.path;
    configCode.textContent = editor.code;
    configNote.textContent = editor.note;
  };
  tabs(document.querySelectorAll('.ide-tab'), 'data-ide', showEditor);
  showEditor('claude');
  const copyConfig = document.getElementById('copyConfigBtn');
  if (copyConfig) copyConfig.addEventListener('click', () => copyText(configCode.textContent, copyConfig));
});
