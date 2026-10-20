import * as fs from 'fs';
import * as path from 'path';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { ImpactAnalyzer } from '../graph/impactAnalyzer.js';
import { ASTSkeletonizer } from './skeletonizer.js';

export interface ContextChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  skeletonSnippet?: string;
  tokens: number;
}

export interface AgentContextPack {
  task: string;
  codebaseName: string;
  tokenCount: number;
  maxTokens?: number;
  isSkeletonized: boolean;
  relevantRules: Record<string, any>;
  impactAnalysis: any;
  topSemanticChunks: ContextChunk[];
}

export class ContextPackGenerator {
  public static generateContextPack(
    repoPath: string, 
    taskDescription: string, 
    maxTokens?: number
  ): AgentContextPack {
    const conventions = ConventionMiner.loadConventions(repoPath);
    // Fetch top semantic candidates
    const topChunks = SemanticSearchEngine.search(repoPath, taskDescription, maxTokens ? 10 : 3);
    const impact = ImpactAnalyzer.analyzeImpact(repoPath, taskDescription);

    const relevantRules = conventions?.rules || {};
    const rulesTokens = ASTSkeletonizer.estimateTokens(JSON.stringify(relevantRules));
    const impactTokens = ASTSkeletonizer.estimateTokens(JSON.stringify(impact));
    let baseTokens = rulesTokens + impactTokens + ASTSkeletonizer.estimateTokens(taskDescription);

    const packedChunks: ContextChunk[] = [];
    let isSkeletonized = false;

    if (maxTokens && maxTokens > 0) {
      let remainingBudget = maxTokens - baseTokens;
      // Reserve at least a reasonable portion for code chunks
      if (remainingBudget < 200) {
        remainingBudget = maxTokens * 0.7; // prioritize code context
      }

      for (const c of topChunks) {
        const relPath = path.relative(repoPath, c.filePath);
        const originalTokens = ASTSkeletonizer.estimateTokens(c.snippet);

        // Try raw snippet first if it fits comfortably
        if (originalTokens <= remainingBudget && !isSkeletonized) {
          packedChunks.push({
            filePath: relPath,
            startLine: c.startLine,
            endLine: c.endLine,
            snippet: c.snippet,
            tokens: originalTokens
          });
          remainingBudget -= originalTokens;
        } else {
          // Skeletonize to save 60-80% tokens while preserving API/AST signatures
          const skeletonResult = ASTSkeletonizer.skeletonize(c.snippet, c.filePath);
          if (skeletonResult.skeletonTokens <= remainingBudget || packedChunks.length === 0) {
            isSkeletonized = true;
            packedChunks.push({
              filePath: relPath,
              startLine: c.startLine,
              endLine: c.endLine,
              snippet: skeletonResult.skeleton,
              skeletonSnippet: skeletonResult.skeleton,
              tokens: skeletonResult.skeletonTokens
            });
            remainingBudget -= skeletonResult.skeletonTokens;
          }
        }

        if (remainingBudget <= 50) break;
      }
    } else {
      // No token budget specified - pack top 3 raw snippets
      topChunks.slice(0, 3).forEach(c => {
        const tokens = ASTSkeletonizer.estimateTokens(c.snippet);
        packedChunks.push({
          filePath: path.relative(repoPath, c.filePath),
          startLine: c.startLine,
          endLine: c.endLine,
          snippet: c.snippet,
          tokens
        });
      });
    }

    const totalChunkTokens = packedChunks.reduce((sum, c) => sum + c.tokens, 0);
    const totalTokens = baseTokens + totalChunkTokens;

    const pack: AgentContextPack = {
      task: taskDescription,
      codebaseName: conventions?.codebaseName || path.basename(repoPath),
      tokenCount: totalTokens,
      maxTokens,
      isSkeletonized,
      relevantRules,
      impactAnalysis: impact,
      topSemanticChunks: packedChunks
    };

    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const packPath = path.join(outDir, 'context_pack.json');
    fs.writeFileSync(packPath, JSON.stringify(pack, null, 2), 'utf8');

    return pack;
  }
}
