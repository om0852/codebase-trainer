import { SemanticSearchEngine, SearchResult } from '../semantic/searchEngine.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import * as path from 'path';
import * as fs from 'fs';

export interface ExecutionStep {
  stepNumber: number;
  title: string;
  filePath: string;
  lineRange: string;
  description: string;
  codeSnippet: string;
  participantName: string;
}

export interface ExecutionFlowResult {
  query: string;
  steps: ExecutionStep[];
  mermaidDiagram: string;
  summaryFlow: string;
}

export class ExecutionFlowTracer {
  public static traceFlow(repoPath: string, featureQuery: string): ExecutionFlowResult {
    const hits: SearchResult[] = SemanticSearchEngine.search(repoPath, featureQuery, 6);
    const graph = CallGraphAnalyzer.analyzeGraph(repoPath);

    // Build dynamic participants based on file basenames
    const participantMap = new Map<string, string>();
    hits.forEach((hit, idx) => {
      const baseName = path.basename(hit.filePath, path.extname(hit.filePath));
      const sanitizedName = baseName.replace(/[^a-zA-Z0-9]/g, '_');
      const participantAlias = `${sanitizedName}_${idx + 1}`;
      participantMap.set(hit.filePath, participantAlias);
    });

    const steps: ExecutionStep[] = hits.map((hit, idx) => {
      const lines = hit.snippet.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      const firstLine = lines[0] || '';
      const baseName = path.basename(hit.filePath);

      // Detect function or symbol definition in snippet
      const funcMatch = hit.snippet.match(/(?:function|class|const|let|var|async)\s+([a-zA-Z0-9_]+)/);
      const symbolRef = funcMatch ? funcMatch[1] : baseName;

      return {
        stepNumber: idx + 1,
        title: `Phase ${idx + 1}: ${symbolRef} (${baseName})`,
        filePath: hit.filePath,
        lineRange: `L${hit.startLine}-L${hit.endLine}`,
        description: `Executes \`${symbolRef}\` in \`${baseName}\` around line ${hit.startLine}. Summary: ${firstLine.slice(0, 60)}...`,
        codeSnippet: hit.snippet.split('\n').slice(0, 6).join('\n'),
        participantName: participantMap.get(hit.filePath) || `Module_${idx + 1}`
      };
    });

    // Dynamically construct Mermaid sequence diagram
    const mermaidLines: string[] = [
      'sequenceDiagram',
      '  autonumber',
      '  actor DeveloperOrClient as User / Client'
    ];

    // Declare sequence participants dynamically
    const addedParticipants = new Set<string>();
    steps.forEach(step => {
      const pAlias = step.participantName;
      if (!addedParticipants.has(pAlias)) {
        addedParticipants.add(pAlias);
        const fileName = path.basename(step.filePath);
        mermaidLines.push(`  participant ${pAlias} as ${fileName}`);
      }
    });

    // Generate sequence interactions
    if (steps.length > 0) {
      mermaidLines.push(`  DeveloperOrClient->>${steps[0].participantName}: 1. Initiate query "${featureQuery}"`);
      for (let i = 0; i < steps.length - 1; i++) {
        const curr = steps[i];
        const next = steps[i + 1];
        if (curr.participantName !== next.participantName) {
          mermaidLines.push(`  ${curr.participantName}->>${next.participantName}: ${i + 2}. Call execution target (${path.basename(next.filePath)})`);
        } else {
          mermaidLines.push(`  ${curr.participantName}->>${curr.participantName}: ${i + 2}. Self-process internal step (${curr.lineRange})`);
        }
      }
      const last = steps[steps.length - 1];
      mermaidLines.push(`  ${last.participantName}-->>DeveloperOrClient: Complete execution flow result`);
    }

    const summaryFlow = steps.map(s =>
      `### Step ${s.stepNumber}: ${s.title}\n- **Location**: \`${s.filePath}:${s.lineRange}\`\n- **Description**: ${s.description}\n\n\`\`\`ts\n${s.codeSnippet}\n\`\`\``
    ).join('\n\n');

    return {
      query: featureQuery,
      steps,
      mermaidDiagram: mermaidLines.join('\n'),
      summaryFlow
    };
  }

  public static generateInteractiveHTML(repoPath: string, flow: ExecutionFlowResult): string {
    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const htmlPath = path.join(outDir, 'flow_viewer.html');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Flow Trace: ${flow.query}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1 { color: #38bdf8; font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .mermaid { background: #0f172a; padding: 16px; border-radius: 6px; overflow-x: auto; }
    .step-badge { background: #0284c7; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    pre { background: #090d16; padding: 12px; border-radius: 6px; overflow-x: auto; color: #a5f3fc; font-size: 13px; }
    .loc { color: #38bdf8; font-family: monospace; font-size: 13px; }
  </style>
</head>
<body>
  <h1>⚡ Execution Flow: "${flow.query}"</h1>
  <div class="subtitle">Generated by Codebase-Trainer • ${flow.steps.length} Steps Traced</div>

  <div class="card">
    <h2>📐 Interactive Sequence Diagram</h2>
    <div class="mermaid">
${flow.mermaidDiagram}
    </div>
  </div>

  <div class="card">
    <h2>📋 Step-by-Step Code Execution Trace</h2>
    ${flow.steps.map(s => `
      <div style="margin-bottom: 20px; border-bottom: 1px solid #334155; padding-bottom: 16px;">
        <div style="display:flex; align-items:center; gap: 8px; margin-bottom: 6px;">
          <span class="step-badge">Step ${s.stepNumber}</span>
          <strong style="color: #f1f5f9;">${s.title}</strong>
        </div>
        <div class="loc">${s.filePath} (${s.lineRange})</div>
        <p style="color: #cbd5e1; margin: 6px 0;">${s.description}</p>
        <pre><code>${s.codeSnippet.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>
      </div>
    `).join('')}
  </div>

  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'dark' });
  </script>
</body>
</html>`;

    fs.writeFileSync(htmlPath, html, 'utf8');
    return htmlPath;
  }
}

