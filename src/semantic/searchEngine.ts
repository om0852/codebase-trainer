import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';

export interface CodeChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  tokens?: string[];
}

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

export class SemanticSearchEngine {
  public static tokenize(text: string): string[] {
    // Split camelCase and PascalCase
    const expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const words = expanded.replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/);
    return words.filter(w => w.length > 1);
  }

  public static chunkFile(filePath: string): CodeChunk[] {
    if (!fs.existsSync(filePath)) return [];
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }

    const lines = content.split(/\r?\n/);
    const chunks: CodeChunk[] = [];
    const chunkSize = 30;
    const overlap = 10;

    for (let i = 0; i < lines.length; i += chunkSize - overlap) {
      const chunkLines = lines.slice(i, i + chunkSize);
      const text = chunkLines.join('\n');
      if (text.trim().length === 0) continue;

      chunks.push({
        id: `${filePath}#L${i + 1}-L${i + chunkLines.length}`,
        filePath,
        startLine: i + 1,
        endLine: i + chunkLines.length,
        content: text,
        tokens: this.tokenize(text)
      });
    }

    return chunks;
  }

  public static buildIndex(repoPath: string): void {
    const facts = ASTExtractor.scanDirectory(repoPath);
    const allChunks: CodeChunk[] = [];

    facts.forEach(f => {
      const fileChunks = this.chunkFile(f.filePath);
      allChunks.push(...fileChunks);
    });

    const storePath = path.join(repoPath, '.codebase', 'embeddings.json');
    const storeDir = path.dirname(storePath);
    if (!fs.existsSync(storeDir)) {
      fs.mkdirSync(storeDir, { recursive: true });
    }

    fs.writeFileSync(storePath, JSON.stringify({ chunks: allChunks }, null, 2), 'utf8');
  }

  /**
   * Industry-Standard Okapi BM25 Search Algorithm
   */
  public static search(repoPath: string, query: string, topK: number = 5): SearchResult[] {
    const storePath = path.join(repoPath, '.codebase', 'embeddings.json');
    if (!fs.existsSync(storePath)) {
      this.buildIndex(repoPath);
    }

    let data: { chunks: CodeChunk[] };
    try {
      data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    } catch {
      return [];
    }

    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 || data.chunks.length === 0) return [];

    const N = data.chunks.length;
    let totalLen = 0;
    const docFreq: Record<string, number> = {};
    const docLengths: number[] = [];

    // Compute Document Frequency (DF) and Average Document Length
    data.chunks.forEach((chunk, i) => {
      const tokens = chunk.tokens || this.tokenize(chunk.content);
      docLengths[i] = tokens.length;
      totalLen += tokens.length;

      const uniqueTokens = new Set(tokens);
      uniqueTokens.forEach(t => {
        docFreq[t] = (docFreq[t] || 0) + 1;
      });
    });

    const avgdl = totalLen / (N || 1);
    const k1 = 1.2;
    const b = 0.75;

    const results: SearchResult[] = data.chunks.map((chunk, i) => {
      const tokens = chunk.tokens || this.tokenize(chunk.content);
      const docLen = docLengths[i];

      // Calculate term frequency map
      const tf: Record<string, number> = {};
      tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });

      let score = 0;
      queryTokens.forEach(qTerm => {
        const n = docFreq[qTerm] || 0;
        if (n > 0) {
          // IDF Calculation
          const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
          const termCount = tf[qTerm] || 0;
          const numerator = termCount * (k1 + 1);
          const denominator = termCount + k1 * (1 - b + b * (docLen / (avgdl || 1)));
          score += idf * (numerator / denominator);
        }
      });

      return {
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        snippet: chunk.content,
        score
      };
    });

    return results
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
