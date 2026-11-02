import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { CallSiteExtractor, FlowEdge } from '../flow/callSites.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';
import { ImportResolver } from '../graph/importResolver.js';
import { extractCodeFacts, SymbolFact } from '../parsing/codeFacts.js';
import { ASTSkeletonizer } from './skeletonizer.js';

export type SliceLayer = 'ui' | 'client' | 'server' | 'service' | 'data' | 'middleware' | 'config' | 'tests' | 'docs';

export interface SliceFile {
  file: string;
  layer: SliceLayer;
  score: number;
  // Why the file is in the slice: a search match, or the edge that reached it
  why: string;
  // Symbols of this file that take part in the feature (edge endpoints and matched definitions)
  symbols: string[];
  // How much of the file is included: full snippets, signatures only, or just the reference
  detail: 'snippets' | 'signatures' | 'ref';
}

export interface SliceSnippet {
  file: string;
  startLine: number;
  endLine: number;
  code: string;
}

export interface FeatureSlice {
  feature: string;
  budgetTokens: number;
  tokens: number;
  files: SliceFile[];
  layers: Partial<Record<SliceLayer, string[]>>;
  // Readable call chains through the slice, e.g. `ApiKeysPage → revokeApiKey → DELETE /api/keys/[id] → deleteApiKey → ApiKey`
  flows: string[];
  // Edges between files in the slice: `from#symbol -> to#symbol [kind label]`
  edges: string[];
  snippets: SliceSnippet[];
  omitted: Array<{ file: string; reason: string }>;
  notes: string[];
}

export interface SliceOptions {
  budgetTokens?: number;
  includeTests?: boolean;
  includeDocs?: boolean;
  // Tuning knobs (defaults chosen on the benchmark's dev split)
  maxFiles?: number;
  minRelativeScore?: number;
  seedHits?: number;
  // Search matches below this share of the top match do not seed the graph walk (they can still be reached by it)
  minSeedScore?: number;
  // Score multiplier for a search match with no edge to any core file of the feature
  isolationPenalty?: number;
}

interface Hop {
  edge: FlowEdge;
  forward: boolean;
}

// Defaults chosen on the benchmark's dev split as the most precise setting that keeps feature recall at 0.8 or
// more (missing a file costs an agent another round trip; an extra file at signature level costs a few tokens)
const DEFAULT_BUDGET = 6000;
const MAX_FILES = 16;
const SEED_HITS = 20;
const MIN_SEED_SCORE = 0.3;
const ISOLATION_PENALTY = 0.4;
const MAX_DEPTH = 3;
// Files whose expanded score falls below this share of the best file are left out
const MIN_RELATIVE_SCORE = 0.2;
const MAX_SNIPPET_LINES = 60;

// How strongly relevance flows along an edge, by direction. A request reaching its handler is part of the feature;
// "other code that also reads this table" (reverse data) usually is not.
const EDGE_WEIGHT: Record<FlowEdge['kind'], { forward: number; reverse: number }> = {
  http: { forward: 0.9, reverse: 0.8 },
  data: { forward: 0.85, reverse: 0.25 },
  call: { forward: 0.7, reverse: 0.6 },
  reference: { forward: 0.5, reverse: 0.4 }
};

const graphCache = new Map<string, { signature: string; edges: FlowEdge[] }>();

/**
 * Everything a feature touches, packed into a token budget: seed files from search, expanded along the call /
 * request / data-layer graph to the UI that triggers the feature and the handlers, services and models it reaches,
 * grouped by layer with the connecting edges as evidence.
 */
export class FeatureSliceBuilder {
  public static build(repoPath: string, feature: string, options: SliceOptions = {}): FeatureSlice {
    const budget = options.budgetTokens ?? DEFAULT_BUDGET;
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');
    const notes: string[] = [];

    // 1. Seeds: best search score per file, normalised to the top file
    const hits = SemanticSearchEngine.search(repoPath, feature, options.seedHits ?? SEED_HITS);
    const seedScore = new Map<string, number>();
    const seedLines = new Map<string, Array<[number, number]>>();
    const top = hits[0]?.score || 1;
    hits.forEach(hit => {
      const rel = toRel(hit.filePath);
      if (hit.kind === 'doc' && !options.includeDocs) return;
      if (hit.kind === 'test' && !options.includeTests) return;
      if (this.isHistoryOrGenerated(rel)) return;
      if (hit.score / top < (options.minSeedScore ?? MIN_SEED_SCORE)) return;
      seedScore.set(rel, Math.max(seedScore.get(rel) ?? 0, hit.score / top));
      seedLines.set(rel, [...(seedLines.get(rel) ?? []), [hit.startLine, hit.endLine]]);
    });
    if (seedScore.size === 0) {
      return this.empty(feature, budget, ['No code matched this feature.']);
    }

    // 2. Graph expansion over typed edges. Like a program slice, a path either walks up to callers (who triggers
    // the feature) or down to callees (what it reaches), never down and back up: that would add siblings, such as
    // every other caller of a shared helper.
    const facts = ASTExtractor.scanDirectory(repoPath);
    const edges = this.edgesFor(repoPath, facts).filter(e => e.from.filePath !== e.to.filePath);
    const out = new Map<string, FlowEdge[]>();
    const into = new Map<string, FlowEdge[]>();
    edges.forEach(e => {
      out.set(e.from.filePath, [...(out.get(e.from.filePath) ?? []), e]);
      into.set(e.to.filePath, [...(into.get(e.to.filePath) ?? []), e]);
    });
    const fanIn = (file: string) => new Set((into.get(file) ?? []).map(e => e.from.filePath)).size;

    type Direction = 'seed' | 'up' | 'down';
    const score = new Map<string, number>(seedScore);
    const direction = new Map<string, Direction>([...seedScore.keys()].map(f => [f, 'seed']));
    const reachedBy = new Map<string, Hop>();
    const depth = new Map<string, number>([...seedScore.keys()].map(f => [f, 0]));
    const frontier = [...seedScore.keys()];
    while (frontier.length > 0) {
      frontier.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
      const file = frontier.shift()!;
      const d = depth.get(file)!;
      const mode = direction.get(file)!;
      if (d >= MAX_DEPTH) continue;
      const hops: Hop[] = [
        ...(mode !== 'up' ? (out.get(file) ?? []).map(edge => ({ edge, forward: true })) : []),
        ...(mode !== 'down' ? (into.get(file) ?? []).map(edge => ({ edge, forward: false })) : [])
      ];
      hops.forEach(hop => {
        const next = hop.forward ? hop.edge.to.filePath : hop.edge.from.filePath;
        if (this.isHistoryOrGenerated(next)) return;
        const weight = hop.forward ? EDGE_WEIGHT[hop.edge.kind].forward : EDGE_WEIGHT[hop.edge.kind].reverse;
        // Shared infrastructure (db client, utils, design-system primitives) is reached from everywhere and says
        // little about this feature
        const hubDamping = 1 / Math.log2(2 + Math.max(0, fanIn(next) - 3));
        const sharedDamping = this.isSharedInfrastructure(next) ? 0.5 : 1;
        const candidate = (score.get(file) ?? 0) * weight * hubDamping * sharedDamping;
        if (candidate > (score.get(next) ?? 0) + 1e-9) {
          score.set(next, candidate);
          if (direction.get(next) !== 'seed') direction.set(next, hop.forward ? 'down' : 'up');
          reachedBy.set(next, hop);
          depth.set(next, d + 1);
          frontier.push(next);
        }
      });
    }

    // A search match that no edge ties to the feature's core files is often a word overlap, not part of the feature
    const coreCut = Math.max(...score.values()) * 0.5;
    const core = new Set([...score.entries()].filter(([, s]) => s >= coreCut).map(([f]) => f));
    const penalty = options.isolationPenalty ?? ISOLATION_PENALTY;
    seedScore.forEach((_, file) => {
      const neighbours = [...(out.get(file) ?? []).map(e => e.to.filePath), ...(into.get(file) ?? []).map(e => e.from.filePath)];
      const connected = neighbours.some(n => n !== file && core.has(n));
      if (!connected && score.get(file)! < Math.max(...score.values())) score.set(file, score.get(file)! * penalty);
    });

    // 3. Select files above the relative threshold
    const best = Math.max(...score.values());
    const ranked = [...score.entries()]
      .filter(([file]) => this.allowed(file, options))
      .filter(([, s]) => s >= best * (options.minRelativeScore ?? MIN_RELATIVE_SCORE))
      .sort((a, b) => b[1] - a[1]);
    const maxFiles = options.maxFiles ?? MAX_FILES;
    const selectedFiles = ranked.slice(0, maxFiles).map(([file]) => file);
    const selected = new Set(selectedFiles);
    const omitted: FeatureSlice['omitted'] = ranked.slice(maxFiles).map(([file]) => ({ file, reason: `beyond ${maxFiles} files` }));

    const sliceEdges = edges.filter(e => selected.has(e.from.filePath) && selected.has(e.to.filePath));
    const symbolsOf = new Map<string, Set<string>>();
    const noteSymbol = (file: string, symbol?: string) => {
      if (!symbol) return;
      symbolsOf.set(file, (symbolsOf.get(file) ?? new Set()).add(symbol));
    };
    sliceEdges.forEach(e => { noteSymbol(e.from.filePath, e.from.symbol); noteSymbol(e.to.filePath, e.to.symbol); });

    // 4. Pack into the budget: signatures for everything first, then upgrade the best files to snippets
    const files: SliceFile[] = selectedFiles.map(file => ({
      file,
      layer: this.layerOf(file, edges),
      score: Number((score.get(file)! / best).toFixed(3)),
      why: this.why(file, seedScore, reachedBy),
      symbols: [...(symbolsOf.get(file) ?? [])],
      detail: 'ref' as SliceFile['detail']
    }));
    const contents = new Map(files.map(f => [f.file, ASTExtractor.readSourceFile(path.join(repoPath, f.file)) ?? '']));
    const symbolFacts = new Map(files.map(f => [f.file, extractCodeFacts(path.join(repoPath, f.file), contents.get(f.file)!)?.symbols ?? []]));

    const header = (f: SliceFile) => ASTSkeletonizer.estimateTokens(`${f.file} ${f.layer} ${f.why} ${f.symbols.join(' ')}`) + 8;
    let tokens = files.reduce((sum, f) => sum + header(f), 0);
    const signatureText = (f: SliceFile) => this.signatures(f, symbolFacts.get(f.file)!, contents.get(f.file)!);
    files.forEach(f => {
      const cost = ASTSkeletonizer.estimateTokens(signatureText(f));
      if (tokens + cost <= budget) {
        f.detail = 'signatures';
        tokens += cost;
      }
    });
    const snippets: SliceSnippet[] = [];
    files.forEach(f => {
      if (f.detail !== 'signatures') return;
      const ranges = this.snippetRanges(f, symbolFacts.get(f.file)!, seedLines.get(f.file) ?? []);
      const lines = contents.get(f.file)!.split(/\r?\n/);
      const fileSnippets = ranges.map(([start, end]) => ({ file: f.file, startLine: start, endLine: end, code: lines.slice(start - 1, end).join('\n') }));
      const extra = ASTSkeletonizer.estimateTokens(fileSnippets.map(s => s.code).join('\n')) - ASTSkeletonizer.estimateTokens(signatureText(f));
      if (fileSnippets.length > 0 && tokens + extra <= budget) {
        f.detail = 'snippets';
        tokens += extra;
        snippets.push(...fileSnippets);
      }
    });
    files.filter(f => f.detail === 'ref').forEach(f => omitted.push({ file: f.file, reason: 'budget (listed as a reference only)' }));

    const layers: FeatureSlice['layers'] = {};
    files.forEach(f => { (layers[f.layer] = layers[f.layer] ?? []).push(f.file); });
    if (!files.some(f => f.layer === 'data')) notes.push('No data-layer model was reached; the feature may not touch persistent data, or the ORM is not recognised.');
    notes.push('Built from search matches plus static import, call, request and data-layer edges; dynamic dispatch and runtime configuration are not traced.');

    return {
      feature,
      budgetTokens: budget,
      tokens,
      files,
      layers,
      flows: this.flows(sliceEdges),
      edges: sliceEdges.map(e => `${e.from.filePath}#${e.from.symbol ?? '?'} -> ${e.to.filePath}#${e.to.symbol ?? '?'} [${e.kind}${e.label ? ` ${e.label}` : ''}]`),
      snippets,
      omitted,
      notes
    };
  }

  private static edgesFor(repoPath: string, facts: ReturnType<typeof ASTExtractor.scanDirectory>): FlowEdge[] {
    // Recompute only when files changed (cheap signature: path + size of every indexed file)
    const stats = ASTExtractor.listSourceFiles(repoPath);
    const signature = stats.map(s => `${s.filePath}:${s.size}:${s.mtimeMs}`).join('|');
    const key = path.resolve(repoPath);
    const cached = graphCache.get(key);
    if (cached && cached.signature === signature) return cached.edges;
    const edges = CallSiteExtractor.extractEdges(repoPath, facts);
    // Imports with no call/request/data edge (types, DTOs, middleware objects such as `auth.required`) still tie a
    // file to the feature, weakly
    const linked = new Set(edges.map(e => `${e.from.filePath}|${e.to.filePath}`));
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');
    Object.entries(ImportResolver.buildImportGraph(repoPath, facts)).forEach(([from, targets]) => {
      targets.forEach(to => {
        const fromRel = toRel(from);
        const toRelPath = toRel(to);
        if (linked.has(`${fromRel}|${toRelPath}`)) return;
        edges.push({ kind: 'reference', from: { filePath: fromRel, line: 1 }, to: { filePath: toRelPath }, evidence: 'import', label: 'imports' });
      });
    });
    graphCache.set(key, { signature, edges });
    return edges;
  }

  // Migration history, lockfiles and generated code restate other files and never need editing by hand
  private static isHistoryOrGenerated(file: string): boolean {
    return /(^|\/)migrations\//.test(file)
      || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(file)
      || /\.gen\.[cm]?[jt]sx?$|(^|\/)(generated|__generated__)\//.test(file);
  }

  // Design-system primitives and shared helpers (`components/ui/card.tsx`, `lib/utils.ts`)
  private static isSharedInfrastructure(file: string): boolean {
    return /(^|\/)(ui|primitives|common|shared|utils?|helpers?)\//.test(file) || /(^|\/)(utils?|helpers?)\.[cm]?[jt]sx?$/.test(file);
  }

  private static allowed(file: string, options: SliceOptions): boolean {
    const kind = SemanticSearchEngine.classifyKind(file, '');
    if (IntentClassifier.isTestFile(file)) return Boolean(options.includeTests);
    if (kind === 'doc') return Boolean(options.includeDocs);
    return true;
  }

  private static layerOf(file: string, edges: FlowEdge[]): SliceLayer {
    const role = IntentClassifier.classifyPath(file).role;
    if (role === 'test_spec') return 'tests';
    if (role === 'documentation') return 'docs';
    if (role === 'middleware') return 'middleware';
    if (file.endsWith('.prisma') || role === 'data_model' || edges.some(e => e.kind === 'data' && e.to.filePath === file)) return 'data';
    if (role === 'page' || role === 'ui_component' || role === 'hook') return 'ui';
    if (role === 'controller_route' || edges.some(e => e.kind === 'http' && e.to.filePath === file)) return 'server';
    if (role === 'store' || edges.some(e => e.kind === 'http' && e.from.filePath === file)) return 'client';
    if (role === 'configuration') return 'config';
    return 'service';
  }

  private static why(file: string, seeds: Map<string, number>, reachedBy: Map<string, Hop>): string {
    const hop = reachedBy.get(file);
    if (!hop) return 'search match';
    const e = hop.edge;
    const label = e.label ? ` (${e.label})` : '';
    return hop.forward
      ? `${e.from.symbol ?? path.basename(e.from.filePath)} in ${e.from.filePath} ${e.kind === 'data' ? 'queries' : e.kind === 'http' ? 'requests' : 'uses'} ${e.to.symbol ?? 'it'}${label}`
      : `${e.from.symbol ?? 'it'} ${e.kind === 'http' ? 'requests' : e.kind === 'data' ? 'queries' : 'uses'} ${e.to.symbol ?? path.basename(e.to.filePath)} in ${e.to.filePath}${label}`;
  }

  // Signatures of the participating symbols (all symbols when none participate), one per line
  private static signatures(f: SliceFile, symbols: SymbolFact[], content: string): string {
    const involved = symbols.filter(s => f.symbols.some(x => x === s.qualifiedName || x === s.name || x.startsWith(`${s.name}.`)));
    const chosen = (involved.length > 0 ? involved : symbols.filter(s => !s.nestedInFunction)).slice(0, 12);
    if (chosen.length > 0) return chosen.map(s => `L${s.startLine}: ${s.signature}`).join('\n');
    // Files without parsed symbols (schemas, config): the first lines stand in for signatures
    return content.split(/\r?\n/).slice(0, 8).join('\n');
  }

  // Line ranges worth showing in full: participating symbols, else the search-matched chunks
  private static snippetRanges(f: SliceFile, symbols: SymbolFact[], seedRanges: Array<[number, number]>): Array<[number, number]> {
    const involved = symbols.filter(s => f.symbols.some(x => x === s.qualifiedName || x === s.name));
    const ranges: Array<[number, number]> = involved.length > 0
      ? involved.map(s => [s.startLine, Math.min(s.endLine, s.startLine + MAX_SNIPPET_LINES - 1)])
      : seedRanges.slice(0, 2).map(([s, e]) => [s, Math.min(e, s + MAX_SNIPPET_LINES - 1)]);
    // Drop ranges nested in others, then sort
    return ranges
      .filter(([s, e], i) => !ranges.some(([s2, e2], j) => j !== i && s2 <= s && e2 >= e && (s2 !== s || e2 !== e || j < i)))
      .sort((a, b) => a[0] - b[0]);
  }

  /**
   * Up to five readable chains, each starting at a file nothing else in the slice calls into.
   */
  private static flows(edges: FlowEdge[]): string[] {
    const out = new Map<string, FlowEdge[]>();
    edges.forEach(e => out.set(e.from.filePath, [...(out.get(e.from.filePath) ?? []), e]));
    const hasCaller = new Set(edges.map(e => e.to.filePath));
    const starts = [...out.keys()].filter(f => !hasCaller.has(f));
    const chains: string[] = [];
    const step = (e: FlowEdge) => e.kind === 'http' || e.kind === 'data' ? `${e.label}` : `${e.to.symbol ?? path.basename(e.to.filePath)}`;
    const walk = (file: string, chain: string[], seen: Set<string>) => {
      const next = (out.get(file) ?? []).filter(e => !seen.has(e.to.filePath));
      if (next.length === 0 || chain.length >= 7) {
        if (chain.length > 1) chains.push(chain.join(' → '));
        return;
      }
      next.slice(0, 2).forEach(e => walk(e.to.filePath, [...chain, step(e)], new Set([...seen, e.to.filePath])));
    };
    starts.forEach(file => {
      const first = out.get(file)![0];
      walk(file, [first.from.symbol ?? path.basename(file)], new Set([file]));
    });
    return [...new Set(chains)].sort((a, b) => b.split('→').length - a.split('→').length).slice(0, 5);
  }

  private static empty(feature: string, budget: number, notes: string[]): FeatureSlice {
    return { feature, budgetTokens: budget, tokens: 0, files: [], layers: {}, flows: [], edges: [], snippets: [], omitted: [], notes };
  }
}
