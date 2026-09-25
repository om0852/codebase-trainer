import * as fs from 'fs';
import * as path from 'path';
import { CodebaseConvention } from '../types/index.js';
import { DependencyGraph } from '../graph/callGraph.js';

export class DashboardGenerator {
  public static generateHTML(repoPath: string, conventions: CodebaseConvention, graph: DependencyGraph): string {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${conventions.codebaseName} - Codebase Intelligence Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --accent: #38bdf8;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
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
      background: #020617;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      color: var(--accent);
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
      max-width: 1200px;
      margin: 0 auto;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    .card h3 {
      margin-top: 0;
      color: var(--text-muted);
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card .val {
      font-size: 28px;
      font-weight: 700;
      color: var(--text);
    }
    .section-title {
      font-size: 20px;
      margin-bottom: 16px;
      color: var(--accent);
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
      background: #0f172a;
      color: var(--text-muted);
      font-size: 13px;
      text-transform: uppercase;
    }
    .tag {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
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
      <span style="color: var(--text-muted); font-size: 14px;">Codebase Trainer Intelligence Dashboard</span>
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
        <h3>Strict Types Required</h3>
        <div class="val" style="color: ${conventions.rules.structural.typeAnnotationRequirement ? 'var(--success)' : 'var(--warning)'}">
          ${conventions.rules.structural.typeAnnotationRequirement ? 'YES' : 'NO'}
        </div>
      </div>
      <div class="card">
        <h3>Mapped Symbols</h3>
        <div class="val">${Object.keys(graph.nodes).length} Nodes</div>
      </div>
    </div>

    <div class="section-title">⚠️ Code Quality & Performance Audit (${graph.qualityIssues.length} issues)</div>
    <table class="table">
      <thead>
        <tr>
          <th>Severity</th>
          <th>File Path</th>
          <th>Issue Description</th>
        </tr>
      </thead>
      <tbody>
        ${graph.qualityIssues.map(issue => `
          <tr>
            <td><span class="tag tag-${issue.severity}">${issue.severity.toUpperCase()}</span></td>
            <td style="font-family: monospace;">${path.relative(repoPath, issue.filePath)}</td>
            <td>${issue.description}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;

    const outPath = path.join(repoPath, '.codebase', 'dashboard.html');
    fs.writeFileSync(outPath, html, 'utf8');
    return outPath;
  }
}
