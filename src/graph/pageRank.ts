import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { CallGraphAnalyzer, DependencyGraph } from './callGraph.js';
import { ImportResolver } from './importResolver.js';
import { ASTFact } from '../types/index.js';

export interface PageRankNode {
  id: string; // File relative path or Symbol key
  type: 'file' | 'symbol';
  score: number;
  inDegree: number;
  outDegree: number;
}

export interface PageRankResult {
  scores: Map<string, number>;
  topFiles: Array<{ filePath: string; score: number; rank: number }>;
  topSymbols: Array<{ symbol: string; filePath: string; score: number; rank: number }>;
}

export class PageRankCalculator {
  /**
   * Computes Graph Centrality / PageRank (Aider repomap style) across all codebase files and symbols.
   * Damping factor d = 0.85, convergence epsilon = 1e-5.
   */
  public static calculate(
    repoPath: string, 
    customFacts?: ASTFact[], 
    customGraph?: DependencyGraph
  ): PageRankResult {
    const facts = customFacts || ASTExtractor.scanDirectory(repoPath);
    const graph = customGraph || CallGraphAnalyzer.analyzeGraph(repoPath);

    // Build unique node set (relative file paths)
    const fileNodes = new Set<string>();
    facts.forEach(f => {
      const rel = path.relative(repoPath, f.filePath).replace(/\\/g, '/');
      fileNodes.add(rel);
    });

    const N = fileNodes.size;
    if (N === 0) {
      return {
        scores: new Map(),
        topFiles: [],
        topSymbols: []
      };
    }

    // Directed edges: outEdges.get(A) = set of files that A imports/depends on
    const outEdges = new Map<string, Set<string>>();
    // inEdges.get(B) = set of files that import/depend on B
    const inEdges = new Map<string, Set<string>>();

    fileNodes.forEach(node => {
      outEdges.set(node, new Set());
      inEdges.set(node, new Set());
    });

    // Populate edges from resolved imports
    const resolvedImports = graph.resolvedImports || ImportResolver.buildImportGraph(repoPath, facts);
    Object.entries(resolvedImports).forEach(([src, targets]) => {
      const srcRel = path.relative(repoPath, src).replace(/\\/g, '/');
      targets.forEach(target => {
        const tgtRel = path.relative(repoPath, target).replace(/\\/g, '/');
        if (tgtRel !== srcRel && fileNodes.has(srcRel) && fileNodes.has(tgtRel)) {
          outEdges.get(srcRel)?.add(tgtRel);
          inEdges.get(tgtRel)?.add(srcRel);
        }
      });
    });

    // Populate function call edges from call graph
    Object.values(graph.nodes || {}).forEach(node => {
      const srcRel = path.relative(repoPath, node.filePath).replace(/\\/g, '/');
      (node.calls || []).forEach(callee => {
        const targetNode = Object.values(graph.nodes).find(n => n.name === callee);
        if (targetNode) {
          const tgtRel = path.relative(repoPath, targetNode.filePath).replace(/\\/g, '/');
          if (tgtRel !== srcRel && fileNodes.has(tgtRel)) {
            outEdges.get(srcRel)?.add(tgtRel);
            inEdges.get(tgtRel)?.add(srcRel);
          }
        }
      });
    });

    // Initialize PageRank: uniform distribution 1/N
    let scores = new Map<string, number>();
    fileNodes.forEach(node => scores.set(node, 1.0 / N));

    const damping = 0.85;
    const maxIterations = 50;
    const epsilon = 1e-5;

    // Power Iteration
    for (let iter = 0; iter < maxIterations; iter++) {
      const nextScores = new Map<string, number>();
      let danglingMass = 0;

      // Sum mass from dangling nodes (out-degree 0)
      fileNodes.forEach(node => {
        const outDegree = outEdges.get(node)?.size || 0;
        if (outDegree === 0) {
          danglingMass += scores.get(node) || 0;
        }
      });

      let totalDiff = 0;

      fileNodes.forEach(u => {
        let incomingRank = 0;
        const incomingNodes = inEdges.get(u) || new Set();

        incomingNodes.forEach(v => {
          const vOutDegree = outEdges.get(v)?.size || 1;
          const vScore = scores.get(v) || 0;
          incomingRank += vScore / vOutDegree;
        });

        const newRank = ((1.0 - damping) / N) + damping * (incomingRank + (danglingMass / N));
        nextScores.set(u, newRank);
        totalDiff += Math.abs(newRank - (scores.get(u) || 0));
      });

      scores = nextScores;
      if (totalDiff < epsilon) {
        break;
      }
    }

    // Rank top files
    const topFiles = Array.from(scores.entries())
      .map(([filePath, score]) => ({ filePath, score: Number(score.toFixed(6)), rank: 1 }))
      .sort((a, b) => b.score - a.score)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));

    // Attribute PageRank to declared symbols
    const symbolScores: Array<{ symbol: string; filePath: string; score: number; rank: number }> = [];
    facts.forEach(f => {
      const rel = path.relative(repoPath, f.filePath).replace(/\\/g, '/');
      const fileRank = scores.get(rel) || (1.0 / N);
      (f.symbols || []).forEach(sym => {
        symbolScores.push({
          symbol: sym,
          filePath: rel,
          score: Number(fileRank.toFixed(6)),
          rank: 1
        });
      });
    });

    const topSymbols = symbolScores
      .sort((a, b) => b.score - a.score)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));

    return {
      scores,
      topFiles,
      topSymbols
    };
  }

  /**
   * Returns PageRank weight multiplier for a given file path.
   */
  public static getFileWeight(repoPath: string, filePath: string, cachedScores?: Map<string, number>): number {
    const rel = path.relative(repoPath, filePath).replace(/\\/g, '/');
    if (cachedScores && cachedScores.has(rel)) {
      return cachedScores.get(rel)!;
    }
    const result = this.calculate(repoPath);
    return result.scores.get(rel) || 0.01;
  }
}
