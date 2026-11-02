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
import { NeuralEmbeddings } from './neuralEmbeddings.js';
import { TreeSitter } from '../parsing/treeSitter.js';
import { extractCodeFacts, SymbolFact } from '../parsing/codeFacts.js';

// Bump when chunk boundaries change; together with the parser in use it decides whether an index is rebuilt
const CHUNKER_VERSION = 3;
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
  matchType?: 'ast-symbol' | 'semantic-bm25' | 'hybrid' | 'neural';
  matchedSymbol?: string;
  pageRankScore?: number;
  denseSimilarity?: number;
  // Cosine similarity from the optional neural model
  neuralSimilarity?: number;
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
  // chunkerId() the chunks were cut with (depends on CHUNKER_VERSION and whether tree-sitter is active)
  chunker?: string;
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

export interface NeuralSearchStatus {
  model: string;
  // Chunks embedded during this search (new or edited since the last one)
  embedded: number;
}

// Reciprocal rank fusion: score = sum over rankings of weight / (RRF_K + rank)
const RRF_K = 60;
// Tuned on the benchmark dev split: half weight keeps the lexical top hit while the neural ranking fills the top 5
const NEURAL_RRF_WEIGHT = 0.5;

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
    // Parse the sanitized text so line numbers match the chunk content even if a secret block was redacted
    const facts = extractCodeFacts(filePath, sanitizedText);
    const ranges = facts ? this.syntaxRanges(facts.symbols, lines.length) : this.windowRanges(1, lines.length, 30, 10);

    ranges.forEach(([start, end]) => {
      const text = lines.slice(start - 1, end).join('\n');
      if (text.trim().length === 0) return;

      const symbols: string[] = [];
      if (facts) {
        facts.symbols.filter(s => s.startLine >= start && s.startLine <= end).forEach(s => {
          symbols.push(s.name);
          if (s.qualifiedName !== s.name) symbols.push(s.qualifiedName);
        });
      } else {
        for (const m of text.matchAll(/(?:function|class|interface|type|const|let|var|def|fn)\s+([A-Za-z0-9_]+)/g)) {
          if (m[1]) symbols.push(m[1]);
        }
      }

      chunks.push({
        id: `${filePath}#L${start}-L${end}`,
        filePath,
        startLine: start,
        endLine: end,
        content: text,
        tokens: this.tokenize(text),
        symbols,
        embedding: DenseVectorEngine.embedText(text)
      });
    });

    return chunks;
  }

  /** Identifies how chunks are cut, so an index built by another chunker (or parser) is rebuilt. */
  public static chunkerId(): string {
    return TreeSitter.isReady() ? `syntax-${CHUNKER_VERSION}` : `lines-${CHUNKER_VERSION}`;
  }

  // Fixed-size overlapping windows over [from, to] (1-based, inclusive). A new window starts every
  // `size - overlap` lines, so the end of a range also gets its own short window (as in the regex fallback since 1.0).
  private static windowRanges(from: number, to: number, size: number, overlap: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (let start = from; start <= to; start += size - overlap) {
      ranges.push([start, Math.min(to, start + size - 1)]);
    }
    return ranges;
  }

  /**
   * Chunk boundaries that follow the code's structure: each top-level function or class is one chunk, large
   * classes split per member, very long bodies split into overlapping windows, and the code between declarations
   * (imports, top-level statements) grouped. Adjacent small pieces are merged so BM25 does not favour fragments.
   */
  private static syntaxRanges(symbols: SymbolFact[], lineCount: number): Array<[number, number]> {
    const MAX_CHUNK = 60;
    const contains = (outer: SymbolFact, inner: SymbolFact) =>
      outer !== inner && outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
    const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    const outer = sorted.filter(s => !sorted.some(o => contains(o, s)));

    const pieces: Array<[number, number]> = [];
    // Code between declarations (imports, top-level statements)
    const addGap = (start: number, end: number) => {
      if (end >= start) pieces.push(...this.windowRanges(start, end, 30, 0));
    };
    const addSpan = (start: number, end: number) => {
      if (end < start) return;
      if (end - start + 1 <= MAX_CHUNK) pieces.push([start, end]);
      else pieces.push(...this.windowRanges(start, end, 40, 10));
    };

    let cursor = 1;
    outer.forEach(symbol => {
      if (symbol.startLine > cursor) addGap(cursor, symbol.startLine - 1);
      const span = symbol.endLine - symbol.startLine + 1;
      const members = sorted.filter(s => contains(symbol, s) && !sorted.some(o => o !== symbol && contains(o, s) && contains(symbol, o)));
      if (span > MAX_CHUNK && members.length > 0) {
        // Class header up to the first member, then each member, then anything after the last member
        let inner = symbol.startLine;
        members.forEach(member => {
          addSpan(inner, member.startLine - 1);
          addSpan(member.startLine, member.endLine);
          inner = member.endLine + 1;
        });
        addSpan(inner, symbol.endLine);
      } else {
        addSpan(symbol.startLine, symbol.endLine);
      }
      cursor = Math.max(cursor, symbol.endLine + 1);
    });
    if (cursor <= lineCount) addGap(cursor, lineCount);

    // Merge neighbouring pieces while the result stays within 30 lines. Merging small declarations with nearby
    // imports and top-level code measured better than keeping them apart (benchmark MRR, dev 0.67 vs 0.66 and
    // holdout 0.76 vs 0.69): the surrounding code carries words that describe what the declaration is for.
    const merged: Array<[number, number]> = [];
    pieces.sort((a, b) => a[0] - b[0]).forEach(([start, end]) => {
      const last = merged[merged.length - 1];
      if (last && start <= last[1] + 1 && start > last[0] && end - last[0] + 1 <= 30) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    });
    return merged;
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
    const meta: IndexMeta = { builtAt: now, refreshedAt: now, files: {}, tokenizer: TOKENIZER_VERSION, chunker: this.chunkerId() };

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
    if (!payload || !payload.meta || payload.meta.tokenizer !== TOKENIZER_VERSION || payload.meta.chunker !== this.chunkerId()) {
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

  /**
   * Search with the optional neural model fused in, when this repo opted in (`cb-trainer embeddings enable`) or
   * `model` is given; otherwise the same as searchWithStatus(). The lexical ranking (BM25, symbols, PageRank) and
   * the neural ranking are combined with reciprocal rank fusion, then weighted by kind (code above tests and docs).
   */
  public static async searchWithStatusAsync(
    repoPath: string,
    query: string,
    topK: number = 5,
    options: { model?: string; neuralWeight?: number } = {}
  ): Promise<{ results: SearchResult[]; index: IndexFreshness; neural?: NeuralSearchStatus; neuralSkipped?: string }> {
    const model = options.model ?? NeuralEmbeddings.config(repoPath)?.model;
    if (!model) return this.searchWithStatus(repoPath, query, topK);
    if (process.env.CODEBASE_ENCRYPTION_KEY || fs.existsSync(path.join(repoPath, '.codebase', '.master.key'))) {
      return { ...this.searchWithStatus(repoPath, query, topK), neuralSkipped: 'The index is encrypted; vectors would be stored unencrypted, so neural search is off.' };
    }

    const { index, chunks } = this.refreshStore(repoPath, process.env.CODEBASE_TRAINER_AUTO_REFRESH !== '0');
    const staleFiles = new Set(index.staleFiles);
    if (chunks.length === 0 || query.trim() === '') return { results: [], index };

    let neural: { vectors: Map<string, Float32Array>; embedded: number };
    let queryVector: Float32Array;
    try {
      neural = await NeuralEmbeddings.chunkVectors(repoPath, model, chunks);
      [queryVector] = await NeuralEmbeddings.embed(model, [query], 'query');
    } catch (err) {
      return { ...this.searchWithStatus(repoPath, query, topK), neuralSkipped: `Neural model unavailable (${(err as Error).message}); lexical results only.` };
    }

    const keyOf = (filePath: string, startLine: number) => `${filePath}:${startLine}`;
    const lexical = this.rankChunks(repoPath, chunks, query, chunks.length);
    const lexicalRank = new Map(lexical.map((r, i) => [keyOf(r.filePath, r.startLine), { result: r, rank: i + 1 }]));
    const similarity = chunks.map(c => NeuralEmbeddings.dot(queryVector, neural.vectors.get(c.id)!));
    const neuralOrder = chunks.map((_, i) => i).sort((a, b) => similarity[b] - similarity[a]);
    const neuralRank = new Map(neuralOrder.map((chunkIndex, rank) => [chunkIndex, rank + 1]));
    const weight = options.neuralWeight ?? NEURAL_RRF_WEIGHT;

    const fused: SearchResult[] = chunks.map((chunk, i) => {
      const lex = lexicalRank.get(keyOf(chunk.filePath, chunk.startLine));
      const kind = lex?.result.kind ?? this.classifyKind(chunk.filePath, repoPath);
      const score = ((lex ? 1 / (RRF_K + lex.rank) : 0) + weight / (RRF_K + neuralRank.get(i)!)) * KIND_SCORE_WEIGHT[kind];
      const base: SearchResult = lex?.result ?? {
        filePath: chunk.filePath, startLine: chunk.startLine, endLine: chunk.endLine, snippet: chunk.content, score: 0, kind, matchType: 'neural'
      };
      return { ...base, score: Number((score * 1000).toFixed(3)), neuralSimilarity: Number(similarity[i].toFixed(3)) };
    });

    const results = fused
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(r => staleFiles.has(this.toRelPath(repoPath, r.filePath)) ? { ...r, stale: true } : r);
    return { results, index, neural: { model, embedded: neural.embedded } };
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
