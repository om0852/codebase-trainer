import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { SecretSanitizer } from '../security/secretSanitizer.js';
import { CodebaseIgnore } from '../extractors/codebaseIgnore.js';
import { IndexEncryption, EncryptedPayload } from '../storage/encryption.js';
import { IndexStore } from '../storage/db.js';
import { PageRankCalculator, PageRankResult } from '../graph/pageRank.js';
import { DenseVectorEngine } from './denseVectorEngine.js';
import { TextNormalizer, TOKENIZER_VERSION } from './textNormalizer.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';

export interface CodeChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  tokens?: string[];
  symbols?: string[];
  embedding?: number[];
}

export type ChunkKind = 'code' | 'test' | 'doc' | 'config';

// Docs and test fixtures often restate code in plain words and win on keyword overlap; keep them
// findable but rank the implementation first
export const KIND_SCORE_WEIGHT: Record<ChunkKind, number> = { code: 1.0, config: 1.0, test: 0.6, doc: 0.5 };
const DOC_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.rst'];
const CONFIG_EXTENSIONS = ['.json', '.yaml', '.yml', '.toml', '.ini'];

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  kind: ChunkKind;
  matchType?: 'ast-symbol' | 'semantic-bm25' | 'hybrid';
  matchedSymbol?: string;
  pageRankScore?: number;
  denseSimilarity?: number;
  // File changed on disk since it was indexed and was not refreshed (auto-refresh disabled)
  stale?: boolean;
}

export interface IndexedFileStat {
  mtimeMs: number;
  size: number;
}

export interface IndexMeta {
  builtAt: string;
  refreshedAt: string;
  // Repo-relative POSIX path -> stats at the time the file was chunked
  files: Record<string, IndexedFileStat>;
  // TOKENIZER_VERSION the stored chunk tokens were produced with
  tokenizer?: number;
}

interface IndexStorePayload {
  chunks: CodeChunk[];
  meta?: IndexMeta;
}

export interface IndexFreshness {
  builtAt: string | null;
  refreshedAt: string | null;
  fullRebuild: boolean;
  checkedFiles: number;
  refreshedFiles: string[];
  removedFiles: string[];
  staleFiles: string[];
  error?: string;
}

export interface SearchOptions {
  topK?: number;
  encrypt?: boolean;
}

export interface CompactSearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  score: number;
  matchType?: SearchResult['matchType'];
  matchedSymbol?: string;
  stale?: boolean;
  snippet: string;
}

export class SemanticSearchEngine {
  public static classifyKind(filePath: string, repoPath?: string): ChunkKind {
    const ext = path.extname(filePath).toLowerCase();
    if (DOC_EXTENSIONS.includes(ext)) return 'doc';
    if (CONFIG_EXTENSIONS.includes(ext)) return 'config';
    // Folder rules (tests/, __tests__/) need the repo-relative path; without a repo root, use the filename only
    const isTest = repoPath
      ? IntentClassifier.isTestFile(path.relative(repoPath, filePath))
      : /\.(test|spec)\.[a-z]+$/i.test(filePath);
    return isTest ? 'test' : 'code';
  }

  // Stemmed tokens for indexed text; queries go through tokenizeQuery, which also drops question words
  public static tokenize(text: string): string[] {
    return TextNormalizer.tokenize(text);
  }

  public static tokenizeQuery(query: string): string[] {
    return TextNormalizer.tokenizeQuery(query);
  }

  public static chunkFile(filePath: string, repoPath?: string): CodeChunk[] {
    if (!fs.existsSync(filePath)) return [];
    if (repoPath && CodebaseIgnore.isIgnoredFile(filePath, repoPath)) return [];

    let rawContent = '';
    try {
      rawContent = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }

    // Enterprise DLP: Sanitize secrets, PII, and credentials before tokenization
    const { sanitizedText } = SecretSanitizer.sanitizeContent(rawContent);

    const lines = sanitizedText.split(/\r?\n/);
    const chunks: CodeChunk[] = [];
    const chunkSize = 30;
    const overlap = 10;

    for (let i = 0; i < lines.length; i += chunkSize - overlap) {
      const chunkLines = lines.slice(i, i + chunkSize);
      const text = chunkLines.join('\n');
      if (text.trim().length === 0) continue;

      // Extract symbols present in this chunk
      const symbols: string[] = [];
      const matches = text.matchAll(/(?:function|class|interface|type|const|let|var|def|fn)\s+([A-Za-z0-9_]+)/g);
      for (const m of matches) {
        if (m[1]) symbols.push(m[1]);
      }

      chunks.push({
        id: `${filePath}#L${i + 1}-L${i + chunkLines.length}`,
        filePath,
        startLine: i + 1,
        endLine: i + chunkLines.length,
        content: text,
        tokens: this.tokenize(text),
        symbols,
        embedding: DenseVectorEngine.embedText(text)
      });
    }

    return chunks;
  }

  private static cachedPageRank: Map<string, PageRankResult> = new Map();

  public static getCachedPageRank(repoPath: string): PageRankResult {
    const key = path.resolve(repoPath);
    if (!this.cachedPageRank.has(key)) {
      this.cachedPageRank.set(key, PageRankCalculator.calculate(repoPath));
    }
    return this.cachedPageRank.get(key)!;
  }

  private static getStorePath(repoPath: string): string {
    return path.join(repoPath, '.codebase', 'embeddings.json');
  }

  private static toRelPath(repoPath: string, filePath: string): string {
    return path.relative(repoPath, filePath).replace(/\\/g, '/');
  }

  /**
   * Reads embeddings.json. `unreadable` is set when the file exists but cannot be parsed or decrypted,
   * so callers never overwrite an encrypted index they merely lack the key for.
   */
  private static readStore(repoPath: string): { payload: IndexStorePayload | null; unreadable: boolean } {
    const storePath = this.getStorePath(repoPath);
    if (!fs.existsSync(storePath)) return { payload: null, unreadable: false };

    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const data = IndexEncryption.isEncrypted(parsed) ? JSON.parse(IndexEncryption.decrypt(parsed, repoPath)) : parsed;
      return { payload: { chunks: data.chunks || [], meta: data.meta }, unreadable: false };
    } catch {
      return { payload: null, unreadable: true };
    }
  }

  public static loadChunks(repoPath: string): CodeChunk[] {
    return this.readStore(repoPath).payload?.chunks || [];
  }

  public static saveChunks(repoPath: string, chunks: CodeChunk[], encrypt: boolean = false, meta?: IndexMeta): void {
    const storePath = this.getStorePath(repoPath);
    const storeDir = path.dirname(storePath);
    if (!fs.existsSync(storeDir)) {
      fs.mkdirSync(storeDir, { recursive: true });
    }

    const payloadStr = JSON.stringify(meta ? { meta, chunks } : { chunks }, null, 2);

    // If encryption is requested or master key is present / environment key set
    const shouldEncrypt = encrypt || Boolean(process.env.CODEBASE_ENCRYPTION_KEY) || fs.existsSync(path.join(repoPath, '.codebase', '.master.key'));

    if (shouldEncrypt) {
      const encrypted = IndexEncryption.encrypt(payloadStr, repoPath);
      fs.writeFileSync(storePath, JSON.stringify(encrypted, null, 2), 'utf8');
    } else {
      fs.writeFileSync(storePath, payloadStr, 'utf8');
    }
  }

  public static buildIndex(repoPath: string, encrypt: boolean = false): void {
    this.cachedPageRank.delete(path.resolve(repoPath));
    const allChunks: CodeChunk[] = [];
    const now = new Date().toISOString();
    const meta: IndexMeta = { builtAt: now, refreshedAt: now, files: {}, tokenizer: TOKENIZER_VERSION };

    ASTExtractor.listSourceFiles(repoPath).forEach(entry => {
      allChunks.push(...this.chunkFile(entry.filePath, repoPath));
      meta.files[this.toRelPath(repoPath, entry.filePath)] = { mtimeMs: entry.mtimeMs, size: entry.size };
    });

    this.saveChunks(repoPath, allChunks, encrypt, meta);
  }

  /**
   * High-Performance Differential Incremental Indexer (<50ms).
   * Only re-chunks modified files and updates index without full rescan.
   * Files that no longer exist or are no longer indexable are dropped from the index.
   */
  public static updateFileChunks(repoPath: string, modifiedFiles: string[]): { updatedCount: number; durationMs: number } {
    const start = Date.now();
    this.cachedPageRank.delete(path.resolve(repoPath));
    const existing = this.readStore(repoPath).payload;
    const modSet = new Set(modifiedFiles.map(f => path.resolve(f)));

    // Retain chunks for unmodified files
    const retained = (existing?.chunks || []).filter(c => !modSet.has(path.resolve(c.filePath)));
    const meta = existing?.meta;

    // Re-chunk changed files that exist
    const newChunks: CodeChunk[] = [];
    modSet.forEach(abs => {
      const rel = this.toRelPath(repoPath, abs);
      let stats: fs.Stats | null = null;
      try {
        stats = ASTExtractor.isIndexablePath(repoPath, abs) ? fs.statSync(abs) : null;
      } catch {
        stats = null;
      }
      if (stats) {
        newChunks.push(...this.chunkFile(abs, repoPath));
        if (meta) meta.files[rel] = { mtimeMs: stats.mtimeMs, size: stats.size };
      } else if (meta) {
        delete meta.files[rel];
      }
    });

    if (meta) meta.refreshedAt = new Date().toISOString();
    const combined = [...retained, ...newChunks];
    this.saveChunks(repoPath, combined, false, meta);
    const durationMs = Date.now() - start;

    return {
      updatedCount: newChunks.length,
      durationMs
    };
  }

  /**
   * Compares the files on disk with the stats recorded at index time. Changed, new and deleted files are
   * re-chunked in place (unless CODEBASE_TRAINER_AUTO_REFRESH=0, in which case they are reported as stale).
   * A missing index, one written before stats were recorded, or one whose tokens came from an older
   * tokenizer is rebuilt in full.
   */
  public static ensureFreshIndex(repoPath: string, autoRefresh: boolean = process.env.CODEBASE_TRAINER_AUTO_REFRESH !== '0'): IndexFreshness {
    return this.refreshStore(repoPath, autoRefresh).index;
  }

  // Returns the chunks it already loaded so search does not parse embeddings.json a second time
  private static refreshStore(repoPath: string, autoRefresh: boolean): { index: IndexFreshness; chunks: CodeChunk[] } {
    const { payload, unreadable } = this.readStore(repoPath);
    const freshness = (meta: IndexMeta | undefined, extra: Partial<IndexFreshness>): IndexFreshness => ({
      builtAt: meta?.builtAt ?? null,
      refreshedAt: meta?.refreshedAt ?? null,
      fullRebuild: false,
      checkedFiles: Object.keys(meta?.files || {}).length,
      refreshedFiles: [],
      removedFiles: [],
      staleFiles: [],
      ...extra
    });

    if (unreadable) {
      return {
        index: freshness(undefined, { error: 'Index exists but could not be read or decrypted; results may be empty or out of date.' }),
        chunks: []
      };
    }
    if (!payload || !payload.meta || payload.meta.tokenizer !== TOKENIZER_VERSION) {
      this.buildIndex(repoPath);
      const rebuilt = this.readStore(repoPath).payload;
      return { index: freshness(rebuilt?.meta, { fullRebuild: true }), chunks: rebuilt?.chunks || [] };
    }

    const meta = payload.meta;
    const changed: string[] = [];
    const seen = new Set<string>();
    ASTExtractor.listSourceFiles(repoPath).forEach(entry => {
      const rel = this.toRelPath(repoPath, entry.filePath);
      seen.add(rel);
      const prev = meta.files[rel];
      if (!prev || prev.mtimeMs !== entry.mtimeMs || prev.size !== entry.size) changed.push(rel);
    });
    const removed = Object.keys(meta.files).filter(rel => !seen.has(rel));

    if (changed.length === 0 && removed.length === 0) {
      return { index: freshness(meta, { checkedFiles: seen.size }), chunks: payload.chunks };
    }
    if (!autoRefresh) {
      return { index: freshness(meta, { checkedFiles: seen.size, staleFiles: [...changed, ...removed] }), chunks: payload.chunks };
    }

    this.updateFileChunks(repoPath, [...changed, ...removed].map(rel => path.join(repoPath, rel)));
    const refreshed = this.readStore(repoPath).payload;
    return {
      index: freshness(refreshed?.meta, { checkedFiles: seen.size, refreshedFiles: changed, removedFiles: removed }),
      chunks: refreshed?.chunks || []
    };
  }

  /**
   * Hybrid search: the sum of Okapi BM25, an exact-symbol bonus, a hashed trigram similarity bonus and a
   * PageRank bonus, scaled by result kind (code, test, doc, config)
   */
  public static search(repoPath: string, query: string, topK: number = 5): SearchResult[] {
    return this.searchWithStatus(repoPath, query, topK).results;
  }

  /**
   * Same as search(), plus the freshness report from the pre-search index check.
   */
  public static searchWithStatus(repoPath: string, query: string, topK: number = 5): { results: SearchResult[]; index: IndexFreshness } {
    const { index, chunks } = this.refreshStore(repoPath, process.env.CODEBASE_TRAINER_AUTO_REFRESH !== '0');
    const staleFiles = new Set(index.staleFiles);
    const results = this.rankChunks(repoPath, chunks, query, topK).map(r =>
      staleFiles.has(this.toRelPath(repoPath, r.filePath)) ? { ...r, stale: true } : r
    );
    return { results, index };
  }

  private static rankChunks(repoPath: string, chunks: CodeChunk[], query: string, topK: number): SearchResult[] {
    const queryTokens = this.tokenizeQuery(query);
    if (queryTokens.length === 0 || chunks.length === 0) return [];

    // Embed the same content words BM25 uses, so "how does X work" does not favour text about how things work
    const queryEmbedding = DenseVectorEngine.embedText(TextNormalizer.queryContentWords(query).join(' '));
    // Check exact symbol matches from query terms (e.g., function/class name)
    // Question words ("how", "does") are not symbol lookups unless the query is nothing else
    const symbolCandidates = query.split(/[\s,()]+/).map(s => s.trim()).filter(s => /^[a-zA-Z0-9_$]{2,}$/.test(s));
    const contentSymbols = symbolCandidates.filter(s => !TextNormalizer.isQueryStopword(s));
    const exactSymbols = contentSymbols.length > 0 ? contentSymbols : symbolCandidates;

    const N = chunks.length;
    let totalLen = 0;
    const docFreq: Record<string, number> = {};
    const docLengths: number[] = [];

    chunks.forEach((chunk, i) => {
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

    const results: SearchResult[] = chunks.map((chunk, i) => {
      const tokens = chunk.tokens || this.tokenize(chunk.content);
      const docLen = docLengths[i];

      const tf: Record<string, number> = {};
      tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });

      let bm25Score = 0;
      queryTokens.forEach(qTerm => {
        const n = docFreq[qTerm] || 0;
        if (n > 0) {
          const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
          const termCount = tf[qTerm] || 0;
          const numerator = termCount * (k1 + 1);
          const denominator = termCount + k1 * (1 - b + b * (docLen / (avgdl || 1)));
          bm25Score += idf * (numerator / denominator);
        }
      });

      // Hybrid AST Symbol Matching
      let symbolBoost = 0;
      let matchedSymbol: string | undefined;

      if (exactSymbols.length > 0) {
        for (const sym of exactSymbols) {
          // Check if chunk explicitly defines this symbol
          if (chunk.symbols && chunk.symbols.includes(sym)) {
            symbolBoost += 5.0; // AST definition match boost
            matchedSymbol = sym;
            break;
          }
          // Exact regex match for definition in content
          const defRegex = new RegExp(`(?:function|class|interface|type|const|let|var|def|fn)\\s+${sym}\\b`);
          if (defRegex.test(chunk.content)) {
            symbolBoost += 6.0;
            matchedSymbol = sym;
            break;
          }
        }
      }

      // Dense Vector Cosine Similarity
      const denseSim = chunk.embedding
        ? DenseVectorEngine.cosineSimilarity(queryEmbedding, chunk.embedding)
        : DenseVectorEngine.cosineSimilarity(queryEmbedding, DenseVectorEngine.embedText(chunk.content));
      const denseSimilarity = Number(denseSim.toFixed(3));
      const vectorBoost = denseSim > 0.35 ? denseSim * 3.0 : 0;

      // Graph Centrality / PageRank Weight (Aider repomap style)
      const pageRankResult = this.getCachedPageRank(repoPath);
      const relPath = path.relative(repoPath, chunk.filePath).replace(/\\/g, '/');
      const prScore = pageRankResult.scores.get(relPath) || (1.0 / (N || 1));
      const pageRankScore = Number((prScore * (N || 1)).toFixed(3));
      
      // Boost central system hubs if there is a keyword, dense vector, or symbol hit
      const hasRelevance = bm25Score > 0 || symbolBoost > 0 || vectorBoost > 0;
      const prBoost = hasRelevance ? Math.min(pageRankScore * 0.75, 2.5) : 0;

      const kind = this.classifyKind(chunk.filePath, repoPath);
      const totalScore = (bm25Score + symbolBoost + vectorBoost + prBoost) * KIND_SCORE_WEIGHT[kind];
      const matchType: SearchResult['matchType'] = symbolBoost > 0 
        ? (bm25Score > 0 || vectorBoost > 0 ? 'hybrid' : 'ast-symbol')
        : (vectorBoost > 0 && bm25Score > 0 ? 'hybrid' : 'semantic-bm25');

      return {
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        snippet: chunk.content,
        score: totalScore,
        kind,
        matchType,
        matchedSymbol,
        pageRankScore,
        denseSimilarity
      };
    });

    return results
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Token-lean view of search hits for agents: repo-relative paths and a snippet narrowed to the
   * lines that best match the query, with startLine/endLine adjusted to the narrowed window.
   */
  public static compactResults(repoPath: string, query: string, hits: SearchResult[], maxLines: number = 12): CompactSearchResult[] {
    const queryTokens = new Set(this.tokenizeQuery(query));

    return hits.map(hit => {
      const lines = hit.snippet.split(/\r?\n/);
      let start = 0;
      if (lines.length > maxLines) {
        const symbol = hit.matchedSymbol?.replace(/\$/g, '\\$');
        // Anchor on the matched definition, else the line with the most query-token hits
        let anchor = symbol
          ? lines.findIndex(l => new RegExp(`(?:function|class|interface|type|const|let|var|def|fn)\\s+${symbol}\\b`).test(l))
          : -1;
        if (anchor < 0) {
          const lineHits = lines.map(l => this.tokenize(l).filter(t => queryTokens.has(t)).length);
          anchor = lineHits.indexOf(Math.max(...lineHits));
        }
        // Keep a couple of lines of lead-in (doc comments, decorators) and give the rest to the body
        start = Math.max(0, Math.min(anchor - 2, lines.length - maxLines));
      }
      const window = lines.slice(start, start + maxLines);

      const compact: CompactSearchResult = {
        filePath: path.relative(repoPath, hit.filePath).replace(/\\/g, '/'),
        startLine: hit.startLine + start,
        endLine: hit.startLine + start + window.length - 1,
        kind: hit.kind,
        score: Number(hit.score.toFixed(2)),
        matchType: hit.matchType,
        snippet: window.join('\n')
      };
      if (hit.matchedSymbol) compact.matchedSymbol = hit.matchedSymbol;
      if (hit.stale) compact.stale = true;
      return compact;
    });
  }
}
