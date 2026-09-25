import { SemanticSearchEngine, SearchResult } from '../semantic/searchEngine.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import * as path from 'path';

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
}

