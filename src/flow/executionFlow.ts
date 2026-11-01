import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { CallSiteExtractor, FlowEdge } from './callSites.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';
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
  edge: FlowEdge;
}

export interface RelatedFile {
  filePath: string;
  startLine: number;
  endLine: number;
  reason: string;
}

export interface ExecutionFlowResult {
  query: string;
  // False when the matching files are not connected by any traced call, reference or HTTP edge
  pathFound: boolean;
  entryPoints: string[];
  steps: ExecutionStep[];
  edges: FlowEdge[];
  // Search matches that are not part of the traced path
  relatedFiles: RelatedFile[];
  mermaidDiagram: string;
  summaryFlow: string;
  notes: string[];
}

const MAX_SEED_FILES = 5;
// Seeds must score at least this fraction of the best code hit; weaker hits are loose vector-similarity matches
const SEED_SCORE_RATIO = 0.5;
const MAX_PATH_DEPTH = 6;
const MAX_EDGES = 30;

const TRACE_LIMITATIONS = 'Edges come from static imports, call sites and fetch/axios URLs matched to route handlers. Calls between functions in the same file, dynamic dispatch, dependency injection, event emitters and callbacks passed through third modules are not traced.';

export class ExecutionFlowTracer {
  public static traceFlow(repoPath: string, featureQuery: string): ExecutionFlowResult {
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');
    const hits = SemanticSearchEngine.search(repoPath, featureQuery, 15)
      .filter(h => h.kind === 'code');

    // Seed files: the distinct code files search ranks highest for the query
    const seeds: string[] = [];
    const seedHits = new Map<string, typeof hits[number]>();
    const minSeedScore = (hits[0]?.score || 0) * SEED_SCORE_RATIO;
    hits.filter(h => h.score >= minSeedScore).forEach(h => {
      const rel = toRel(h.filePath);
      if (!seedHits.has(rel) && seeds.length < MAX_SEED_FILES) {
        seeds.push(rel);
        seedHits.set(rel, h);
      }
    });

    const facts = ASTExtractor.scanDirectory(repoPath);
    const allEdges = CallSiteExtractor.extractEdges(repoPath, facts).filter(e => !IntentClassifier.isTestFile(e.from.filePath));
    const outEdges = new Map<string, FlowEdge[]>();
    const inEdges = new Map<string, FlowEdge[]>();
    allEdges.forEach(e => {
      outEdges.set(e.from.filePath, [...(outEdges.get(e.from.filePath) || []), e]);
      inEdges.set(e.to.filePath, [...(inEdges.get(e.to.filePath) || []), e]);
    });

    const entryPoints = this.findEntryPoints(repoPath, seeds, inEdges, outEdges);
    const selected = this.selectEdges(seeds, entryPoints, outEdges);
    const ordered = this.orderEdges(selected, entryPoints);

    const onPath = new Set<string>();
    ordered.forEach(e => { onPath.add(e.from.filePath); onPath.add(e.to.filePath); });
    const relatedFiles: RelatedFile[] = seeds
      .filter(s => !onPath.has(s))
      .map(s => ({
        filePath: s,
        startLine: seedHits.get(s)!.startLine,
        endLine: seedHits.get(s)!.endLine,
        reason: ordered.length > 0 ? 'Search match not connected to the traced path' : 'Search match; no call path found between matching files'
      }));

    const steps = this.buildSteps(repoPath, ordered);
    const pathFound = ordered.length > 0;
    const notes = [TRACE_LIMITATIONS];
    if (!pathFound) {
      notes.unshift(seeds.length > 0
        ? 'No call path found: the files matching this query do not call each other through any traced edge. They are listed under relatedFiles.'
        : 'No code matched this query.');
    }
    if (selected.length > MAX_EDGES) {
      notes.push(`Showing the first ${MAX_EDGES} of ${selected.length} edges.`);
    }

    return {
      query: featureQuery,
      pathFound,
      entryPoints: pathFound ? entryPoints.filter(e => onPath.has(e)) : [],
      steps,
      edges: ordered,
      relatedFiles,
      mermaidDiagram: this.buildMermaid(featureQuery, steps, entryPoints),
      summaryFlow: this.buildSummary(featureQuery, steps, relatedFiles, notes),
      notes
    };
  }


  /**
   * True for files that start a flow: Next.js pages, layouts, route handlers and middleware, CLI command
   * definitions, MCP/Express/Flask/FastAPI handlers, React roots, and Python `__main__` scripts.
   */
  public static isEntryFile(relPath: string, content: string): boolean {
    if (/(^|\/)(app|pages)\/(.*\/)?(page|layout)\.(t|j)sx?$/.test(relPath)) return true;
    if (/(^|\/)pages\/(?!_)[^/].*\.(t|j)sx?$/.test(relPath)) return true;
    if (/(^|\/)route\.(t|j)s$/.test(relPath) || /(^|\/)middleware\.(t|j)s$/.test(relPath)) return true;
    // Ignore examples in comments such as "// router.get('/x', handler)"
    const code = relPath.endsWith('.py')
      ? content.replace(/(^|\s)#.*$/gm, '$1')
      : content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    return /\.command\(\s*['"`]/.test(code)
      || /\bsetRequestHandler\(/.test(code)
      || /\b(?:app|router)\.(?:get|post|put|delete|patch)\s*\(\s*['"`]/.test(code)
      || /\bcreateRoot\(|ReactDOM\.render\(/.test(code)
      || /if\s+__name__\s*==\s*['"]__main__['"]/.test(code)
      || /@(?:app|router)\.(?:get|post|put|delete|patch|route)\(/.test(code);
  }

  /**
   * Walks callers of the seed files (up to MAX_PATH_DEPTH hops) and keeps the entry files among them.
   * Falls back to caller-less roots, then to the seeds themselves.
   */
  private static findEntryPoints(
    repoPath: string,
    seeds: string[],
    inEdges: Map<string, FlowEdge[]>,
    outEdges: Map<string, FlowEdge[]>
  ): string[] {
    const reachable = new Map<string, number>(seeds.map(s => [s, 0]));
    const queue = [...seeds];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const depth = reachable.get(node)!;
      if (depth >= MAX_PATH_DEPTH) continue;
      (inEdges.get(node) || []).forEach(e => {
        if (!reachable.has(e.from.filePath)) {
          reachable.set(e.from.filePath, depth + 1);
          queue.push(e.from.filePath);
        }
      });
    }

    const candidates = Array.from(reachable.keys());
    const readSafe = (rel: string) => {
      try {
        return fs.readFileSync(path.join(repoPath, rel), 'utf8');
      } catch {
        return '';
      }
    };
    let entries = candidates.filter(c => this.isEntryFile(c, readSafe(c)));
    if (entries.length === 0) {
      entries = candidates.filter(c => (inEdges.get(c) || []).length === 0 && (outEdges.get(c) || []).length > 0);
    }
    if (entries.length === 0) entries = seeds.filter(s => (outEdges.get(s) || []).length > 0);

    // Prefer entries that reach the most seeds, then the ones furthest upstream of a seed
    const seedSet = new Set(seeds);
    const reach = (entry: string) => {
      const seen = new Set([entry]);
      const q = [entry];
      while (q.length > 0) {
        (outEdges.get(q.shift()!) || []).forEach(e => {
          if (seen.has(e.to.filePath)) return;
          seen.add(e.to.filePath);
          q.push(e.to.filePath);
        });
      }
      return seen;
    };
    const ranked = entries
      .map(e => {
        const reached = reach(e);
        return { e, reached, seedsReached: Array.from(reached).filter(f => seedSet.has(f)).length, depth: reachable.get(e) ?? 0 };
      })
      .filter(x => x.seedsReached > 0)
      .sort((a, b) => b.seedsReached - a.seedsReached || b.depth - a.depth);

    // An entry another kept entry already reaches (e.g. a route handler fetched by the page) is a step, not a start
    const kept: Array<{ e: string; reached: Set<string> }> = [];
    ranked.forEach(x => {
      if (kept.length < 3 && !kept.some(k => k.reached.has(x.e))) kept.push(x);
    });
    return kept.map(x => x.e);
  }

  /**
   * Keeps the shortest entry -> seed paths, edges between seeds, and the HTTP hop out of any file on the
   * path plus one hop of calls inside the handler it reaches (page -> store -> fetch -> route -> data layer).
   */
  private static selectEdges(seeds: string[], entryPoints: string[], outEdges: Map<string, FlowEdge[]>): FlowEdge[] {
    const selected = new Set<FlowEdge>();
    const parent = new Map<string, FlowEdge | null>(entryPoints.map(e => [e, null]));
    const depth = new Map<string, number>(entryPoints.map(e => [e, 0]));
    const queue = [...entryPoints];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (depth.get(node)! >= MAX_PATH_DEPTH) continue;
      (outEdges.get(node) || []).forEach(e => {
        if (parent.has(e.to.filePath)) return;
        parent.set(e.to.filePath, e);
        depth.set(e.to.filePath, depth.get(node)! + 1);
        queue.push(e.to.filePath);
      });
    }

    seeds.forEach(seed => {
      let edge = parent.get(seed);
      while (edge) {
        selected.add(edge);
        edge = parent.get(edge.from.filePath);
      }
    });

    const onPath = new Set<string>([...entryPoints, ...seeds]);
    selected.forEach(e => { onPath.add(e.from.filePath); onPath.add(e.to.filePath); });
    const seedSet = new Set(seeds);
    seeds.forEach(s => (outEdges.get(s) || []).forEach(e => {
      if (seedSet.has(e.to.filePath)) selected.add(e);
    }));
    Array.from(onPath).forEach(file => (outEdges.get(file) || []).forEach(e => {
      if (e.kind !== 'http') return;
      selected.add(e);
      (outEdges.get(e.to.filePath) || [])
        .filter(next => next.kind !== 'reference' && (!e.to.symbol || next.from.symbol === e.to.symbol))
        .forEach(next => selected.add(next));
    }));

    return Array.from(selected);
  }

  /**
   * Depth-first from the entry points in source-line order, so the sequence reads in call order. After an
   * edge into `fn`, only edges made from inside `fn` are followed next. Edges not reached are appended.
   */
  private static orderEdges(edges: FlowEdge[], entryPoints: string[]): FlowEdge[] {
    const byFrom = new Map<string, FlowEdge[]>();
    edges.forEach(e => byFrom.set(e.from.filePath, [...(byFrom.get(e.from.filePath) || []), e]));
    byFrom.forEach(list => list.sort((a, b) => a.from.line - b.from.line));

    const ordered: FlowEdge[] = [];
    const emitted = new Set<FlowEdge>();
    const visiting = new Set<string>();
    const visit = (file: string, symbol?: string) => {
      const key = `${file}#${symbol || ''}`;
      if (visiting.has(key)) return;
      visiting.add(key);
      (byFrom.get(file) || [])
        .filter(e => !symbol || e.from.symbol === symbol)
        .forEach(e => {
          if (emitted.has(e)) return;
          emitted.add(e);
          ordered.push(e);
          visit(e.to.filePath, e.to.symbol);
        });
      visiting.delete(key);
    };
    entryPoints.forEach(entry => visit(entry));
    edges.filter(e => !emitted.has(e)).sort((a, b) => a.from.filePath.localeCompare(b.from.filePath) || a.from.line - b.from.line)
      .forEach(e => ordered.push(e));
    return ordered.slice(0, MAX_EDGES);
  }

  private static buildSteps(repoPath: string, edges: FlowEdge[]): ExecutionStep[] {
    const participants = new Map<string, string>();
    const aliasFor = (file: string) => {
      if (!participants.has(file)) {
        const base = path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9]/g, '_');
        participants.set(file, `${base}_${participants.size + 1}`);
      }
      return participants.get(file)!;
    };
    const fileLines = new Map<string, string[]>();
    const linesOf = (rel: string) => {
      if (!fileLines.has(rel)) {
        try {
          fileLines.set(rel, fs.readFileSync(path.join(repoPath, rel), 'utf8').split(/\r?\n/));
        } catch {
          fileLines.set(rel, []);
        }
      }
      return fileLines.get(rel)!;
    };

    return edges.map((edge, idx) => {
      aliasFor(edge.from.filePath);
      aliasFor(edge.to.filePath);
      const fromName = edge.from.symbol || path.basename(edge.from.filePath);
      const target = `${edge.to.filePath}${edge.to.line ? `:${edge.to.line}` : ''}`;
      const verb = edge.kind === 'http' ? `sends \`${edge.label}\` to` : edge.kind === 'call' ? 'calls' : 'passes';
      const toName = edge.kind === 'http' ? `\`${edge.to.symbol || 'handler'}\`` : `\`${edge.to.symbol}\``;
      const lines = linesOf(edge.from.filePath);
      const start = Math.max(1, edge.from.line - 1);
      const end = Math.min(lines.length || edge.from.line, edge.from.line + 1);

      return {
        stepNumber: idx + 1,
        title: `${fromName} ${edge.kind === 'http' ? edge.label : `-> ${edge.to.symbol}`}`,
        filePath: edge.from.filePath,
        lineRange: `L${edge.from.line}`,
        description: `\`${fromName}\` (${edge.from.filePath}:${edge.from.line}) ${verb} ${toName} in ${target}.`,
        codeSnippet: lines.length > 0 ? lines.slice(start - 1, end).join('\n') : edge.evidence,
        participantName: participants.get(edge.from.filePath)!,
        edge
      };
    });
  }

  private static buildMermaid(query: string, steps: ExecutionStep[], entryPoints: string[]): string {
    const clean = (s: string) => s.replace(/["#;]/g, '').replace(/[<>]/g, '');
    if (steps.length === 0) {
      return `flowchart TD\n  none["No call path found for: ${clean(query)}"]`;
    }

    const aliases = new Map<string, string>();
    const lines = ['sequenceDiagram', '  autonumber'];
    const declare = (file: string) => {
      if (aliases.has(file)) return aliases.get(file)!;
      const alias = `${path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9]/g, '_')}_${aliases.size + 1}`;
      aliases.set(file, alias);
      lines.push(`  participant ${alias} as ${clean(file)}`);
      return alias;
    };
    // Entry points first so the diagram reads left to right from where the flow starts
    entryPoints.filter(e => steps.some(s => s.edge.from.filePath === e)).forEach(declare);
    steps.forEach(s => { declare(s.edge.from.filePath); declare(s.edge.to.filePath); });

    steps.forEach(s => {
      const from = aliases.get(s.edge.from.filePath)!;
      const to = aliases.get(s.edge.to.filePath)!;
      const caller = s.edge.from.symbol ? `${clean(s.edge.from.symbol)}: ` : '';
      if (s.edge.kind === 'http') {
        lines.push(`  ${from}->>${to}: ${caller}HTTP ${clean(s.edge.label || '')}`);
      } else if (s.edge.kind === 'call') {
        lines.push(`  ${from}->>${to}: ${caller}${clean(s.edge.to.symbol || '')}()`);
      } else {
        lines.push(`  ${from}-->>${to}: ${caller}passes ${clean(s.edge.to.symbol || '')}`);
      }
    });
    return lines.join('\n');
  }

  private static buildSummary(query: string, steps: ExecutionStep[], related: RelatedFile[], notes: string[]): string {
    const parts: string[] = [];
    if (steps.length > 0) {
      parts.push(steps.map(s =>
        `### Step ${s.stepNumber}: ${s.title}\n- **Edge** (${s.edge.kind}): ${s.description}\n\n\`\`\`\n${s.codeSnippet}\n\`\`\``
      ).join('\n\n'));
    } else {
      parts.push(`No call path found for "${query}".`);
    }
    if (related.length > 0) {
      parts.push(`### Related files (search matches, not on a traced path)\n${related.map(r => `- \`${r.filePath}:${r.startLine}-${r.endLine}\``).join('\n')}`);
    }
    parts.push(notes.map(n => `> ${n}`).join('\n'));
    return parts.join('\n\n');
  }

  public static generateInteractiveHTML(repoPath: string, flow: ExecutionFlowResult): string {
    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const htmlPath = path.join(outDir, 'flow_viewer.html');
    const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Flow Trace: ${escapeHtml(flow.query)}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1 { color: #38bdf8; font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .mermaid { background: #0f172a; padding: 16px; border-radius: 6px; overflow-x: auto; }
    .step-badge { background: #0284c7; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .kind { color: #94a3b8; font-size: 12px; text-transform: uppercase; }
    pre { background: #090d16; padding: 12px; border-radius: 6px; overflow-x: auto; color: #a5f3fc; font-size: 13px; }
    .loc { color: #38bdf8; font-family: monospace; font-size: 13px; }
    .note { color: #cbd5e1; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Execution Flow: "${escapeHtml(flow.query)}"</h1>
  <div class="subtitle">Generated by Codebase-Trainer • ${flow.pathFound ? `${flow.steps.length} traced edges from ${flow.entryPoints.map(escapeHtml).join(', ')}` : 'No call path found'}</div>

  <div class="card">
    <h2>Sequence Diagram</h2>
    <div class="mermaid">
${flow.mermaidDiagram}
    </div>
  </div>

  <div class="card">
    <h2>Traced Steps</h2>
    ${flow.steps.map(s => `
      <div style="margin-bottom: 20px; border-bottom: 1px solid #334155; padding-bottom: 16px;">
        <div style="display:flex; align-items:center; gap: 8px; margin-bottom: 6px;">
          <span class="step-badge">Step ${s.stepNumber}</span>
          <strong style="color: #f1f5f9;">${escapeHtml(s.title)}</strong>
          <span class="kind">${s.edge.kind}</span>
        </div>
        <div class="loc">${escapeHtml(s.filePath)} (${s.lineRange})</div>
        <p style="color: #cbd5e1; margin: 6px 0;">${escapeHtml(s.description)}</p>
        <pre><code>${escapeHtml(s.codeSnippet)}</code></pre>
      </div>
    `).join('')}
    ${flow.relatedFiles.length > 0 ? `<h3>Related files (not on a traced path)</h3><ul>${flow.relatedFiles.map(r => `<li class="loc">${escapeHtml(r.filePath)}:${r.startLine}-${r.endLine}</li>`).join('')}</ul>` : ''}
    ${flow.notes.map(n => `<p class="note">${escapeHtml(n)}</p>`).join('')}
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
