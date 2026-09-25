import * as fs from 'fs';
import * as path from 'path';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { ImpactAnalyzer } from '../graph/impactAnalyzer.js';

export interface AgentContextPack {
  task: string;
  codebaseName: string;
  relevantRules: Record<string, any>;
  impactAnalysis: any;
  topSemanticChunks: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    snippet: string;
  }>;
}

export class ContextPackGenerator {
  public static generateContextPack(repoPath: string, taskDescription: string): AgentContextPack {
    const conventions = ConventionMiner.loadConventions(repoPath);
    const topChunks = SemanticSearchEngine.search(repoPath, taskDescription, 3);
    const impact = ImpactAnalyzer.analyzeImpact(repoPath, taskDescription);

    const pack: AgentContextPack = {
      task: taskDescription,
      codebaseName: conventions?.codebaseName || path.basename(repoPath),
      relevantRules: conventions?.rules || {},
      impactAnalysis: impact,
      topSemanticChunks: topChunks.map(c => ({
        filePath: path.relative(repoPath, c.filePath),
        startLine: c.startLine,
        endLine: c.endLine,
        snippet: c.snippet
      }))
    };

    const packPath = path.join(repoPath, '.codebase', 'context_pack.json');
    fs.writeFileSync(packPath, JSON.stringify(pack, null, 2), 'utf8');

    return pack;
  }
}
