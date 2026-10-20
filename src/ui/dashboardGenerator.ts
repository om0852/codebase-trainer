import * as fs from 'fs';
import * as path from 'path';
import { CodebaseConvention } from '../types/index.js';
import { DependencyGraph } from '../graph/callGraph.js';

export class DashboardGenerator {
  public static generateHTML(repoPath: string, conventions: CodebaseConvention, graph: DependencyGraph): string {
    // Generate Mermaid dependency diagram lines
    const mermaidLines: string[] = ['graph TD'];
    const addedEdges = new Set<string>();
    const nodeAliases = new Map<string, string>();

    function getAlias(filePath: string): string {
      if (!nodeAliases.has(filePath)) {
        const base = path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9]/g, '_');
        const alias = `${base}_${nodeAliases.size + 1}`;
        nodeAliases.set(filePath, alias);
      }
      return nodeAliases.get(filePath)!;
    }

    // Add nodes & edges from importsMap (limit to top 40 for clarity)
    const fileEntries = Object.entries(graph.importsMap || {}).slice(0, 35);
    fileEntries.forEach(([filePath, imports]) => {
      const srcAlias = getAlias(filePath);
      const srcName = path.basename(filePath);
      mermaidLines.push(`  ${srcAlias}["${srcName}"]`);

      imports.forEach(imp => {
        // Find if this import maps to an existing file
        const targetFile = Object.keys(graph.importsMap).find(f => f.includes(imp) || f.endsWith(`${imp}.ts`) || f.endsWith(`${imp}.js`));
        if (targetFile && targetFile !== filePath) {
          const tgtAlias = getAlias(targetFile);
          const edgeKey = `${srcAlias}-->${tgtAlias}`;
          if (!addedEdges.has(edgeKey)) {
            addedEdges.add(edgeKey);
            mermaidLines.push(`  ${srcAlias} --> ${tgtAlias}`);
          }
        }
      });
    });

    // Style circular dependencies if detected
    const circularFiles = new Set<string>();
    graph.qualityIssues.forEach(q => {
      if (q.type === 'circular_dependency' && q.filePath) {
        circularFiles.add(q.filePath);
      }
    });

    circularFiles.forEach(f => {
      if (nodeAliases.has(f)) {
        mermaidLines.push(`  style ${nodeAliases.get(f)} fill:#7f1d1d,stroke:#ef4444,stroke-width:3px,color:#fee2e2`);
      }
    });

    const mermaidSource = mermaidLines.join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${conventions.codebaseName} - Codebase Intelligence Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131c2e;
      --card-border: #1e293b;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.15);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --border: #243247;
      --warning: #f59e0b;
      --error: #ef4444;
      --success: #10b981;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
    }
    .header {
      padding: 24px 40px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #060911;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge {
      background: #0369a1;
      color: #e0f2fe;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
    }
    .container {
      padding: 40px;
      max-width: 1280px;
      margin: 0 auto;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px 24px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
    }
    .card h3 {
      margin-top: 0;
      color: var(--text-muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card .val {
      font-size: 28px;
      font-weight: 700;
      color: var(--text);
    }
    .tabs {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.2s;
    }
    .tab-btn:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.05);
    }
    .tab-btn.active {
      color: var(--accent);
      background: var(--accent-glow);
      border-color: var(--accent);
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .mermaid-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      overflow-x: auto;
      text-align: center;
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .table th, .table td {
      padding: 14px 20px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .table th {
      background: #090e1a;
      color: var(--text-muted);
      font-size: 13px;
      text-transform: uppercase;
    }
    .tag {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .tag-warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
    .tag-error { background: rgba(239, 68, 68, 0.2); color: var(--error); }
    .tag-info { background: rgba(56, 189, 248, 0.2); color: var(--accent); }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>🚀 ${conventions.codebaseName}</h1>
      <span style="color: var(--text-muted); font-size: 14px;">Codebase Trainer Intelligence & Architecture Dashboard</span>
    </div>
    <div class="badge">v${conventions.version} • Model Loaded</div>
  </div>

  <div class="container">
    <div class="grid">
      <div class="card">
        <h3>Constants Placement</h3>
        <div class="val">${conventions.rules.structural.constantsPlacement.toUpperCase()}</div>
      </div>
      <div class="card">
        <h3>Export Convention</h3>
        <div class="val">${conventions.rules.structural.exportStyle.toUpperCase()}</div>
      </div>
      <div class="card">
        <h3>Strict Types</h3>
        <div class="val" style="color: ${conventions.rules.structural.typeAnnotationRequirement ? 'var(--success)' : 'var(--warning)'}">
          ${conventions.rules.structural.typeAnnotationRequirement ? 'ENFORCED' : 'OPTIONAL'}
        </div>
      </div>
      <div class="card">
        <h3>Mapped Symbols</h3>
        <div class="val">${Object.keys(graph.nodes).length} Nodes</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('graph-tab', this)">📐 Architecture Call Graph</button>
      <button class="tab-btn" onclick="switchTab('quality-tab', this)">⚠️ Quality & Performance (${graph.qualityIssues.length})</button>
    </div>

    <!-- Tab 1: Interactive Mermaid Architecture Graph -->
    <div id="graph-tab" class="tab-content active">
      <div class="mermaid-box">
        <h3 style="margin-top:0; color:var(--text-muted); text-align:left;">Interactive Module Dependency & Call Graph</h3>
        <p style="color:var(--text-muted); font-size:13px; text-align:left; margin-bottom:16px;">
          Red highlighted nodes indicate detected circular import dependencies or hotspot bottlenecks.
        </p>
        <div class="mermaid">
${mermaidSource}
        </div>
      </div>
    </div>

    <!-- Tab 2: Quality Issues Table -->
    <div id="quality-tab" class="tab-content">
      <table class="table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Type</th>
            <th>File Path</th>
            <th>Issue Description</th>
          </tr>
        </thead>
        <tbody>
          ${graph.qualityIssues.length === 0 ? `
            <tr><td colspan="4" style="text-align:center; color:var(--success); padding:24px;">✨ No performance bottlenecks or circular dependencies detected!</td></tr>
          ` : graph.qualityIssues.map(issue => `
            <tr>
              <td><span class="tag tag-${issue.severity}">${issue.severity}</span></td>
              <td style="font-size:12px; font-weight:600; color:var(--text-muted);">${issue.type.replace(/_/g, ' ').toUpperCase()}</td>
              <td style="font-family: monospace; font-size:13px;">${path.relative(repoPath, issue.filePath)}${issue.line ? `:${issue.line}` : ''}</td>
              <td style="font-size:13px;">${issue.description}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose' });

    function switchTab(tabId, btn) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      btn.classList.add('active');
    }
  </script>
</body>
</html>`;

    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'dashboard.html');
    fs.writeFileSync(outPath, html, 'utf8');
    return outPath;
  }
}
