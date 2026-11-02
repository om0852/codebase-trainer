import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execFileSync } from 'child_process';
import { SemanticSearchEngine } from '../src/semantic/searchEngine.js';
import { TextNormalizer } from '../src/semantic/textNormalizer.js';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { FeatureSliceBuilder } from '../src/context/featureSlice.js';
import { BENCH_DIR, CorpusRepo, ensureRepo, loadCorpus } from './corpus.js';

/**
 * Retrieval benchmark: for each labelled question, compare the files codebase-trainer's search returns
 * against a scripted grep baseline, on the same file set.
 *
 *   tsx bench/run.ts [--split=dev|holdout|all] [--repos=a,b] [--label=1.4.0]
 *                    [--baseline=bench/baseline-dev.json] [--write-baseline]   (writes bench/baseline-<split>.json)
 */

interface Question {
  id: string;
  type: 'locate' | 'feature';
  split: 'dev' | 'holdout';
  question: string;
  files: string[];
  note?: string;
}

interface Ranking {
  files: string[];
  ms: number;
}

interface QuestionResult {
  id: string;
  type: Question['type'];
  // 1-based rank of the first expected file (locate), or null when not in the top RANK_DEPTH
  firstHit: number | null;
  // Share of expected files in the top 10 (feature)
  recallAt10: number;
  // Tokens read, opening ranked files in order, until the question is answered (null = not within RANK_DEPTH)
  tokensToAnswer: number | null;
}

interface MethodSummary {
  locate: { count: number; hitAt1: number; hitAt5: number; mrr: number; medianTokens: number | null; answeredAt20: number };
  feature: { count: number; recallAt10: number; fullyCoveredAt20: number; medianTokens: number | null };
}

// feature_slice on "feature" questions: everything the agent gets in one call, within the default budget
interface SliceResult {
  id: string;
  recall: number;
  precision: number;
  covered: boolean;
  tokens: number;
  files: number;
}

interface SliceSummary {
  count: number;
  recall: number;
  precision: number;
  fullyCovered: number;
  medianTokens: number | null;
  medianFiles: number | null;
}

interface RepoReport {
  // Files the tool indexes vs tracked text files grep can see
  files: number;
  trackedFiles: number;
  // Ground-truth files the tool does not index (it can never return them)
  notIndexed: string[];
  index: { buildMs: number; bytes: number };
  latency: { p50: number; p95: number };
  tool: MethodSummary;
  grep: MethodSummary;
  slice: SliceSummary;
  questions: { tool: QuestionResult[]; grep: QuestionResult[]; slice: SliceResult[] };
}

interface BenchReport {
  label: string;
  date: string;
  split: string;
  repos: Record<string, RepoReport>;
  overall: { tool: MethodSummary; grep: MethodSummary; slice: SliceSummary };
}

const RANK_DEPTH = 20;
// Headline metrics guarded by the regression check, and the largest drop tolerated
const GUARDED = ['locate.hitAt5', 'locate.mrr', 'feature.recallAt10'] as const;
const MAX_DROP = 0.02;

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [key, value] = a.replace(/^--/, '').split('=');
  return [key, value ?? 'true'];
}));

const tokensOf = (text: string) => Math.ceil(text.length / 4);
const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const round = (n: number) => Number(n.toFixed(3));

function loadQuestions(repo: CorpusRepo, split: string): Question[] {
  const file = path.join(BENCH_DIR, 'questions', `${repo.name}.yaml`);
  if (!fs.existsSync(file)) return [];
  const doc = yaml.load(fs.readFileSync(file, 'utf8')) as { questions: Question[] };
  return (doc.questions || []).filter(q => split === 'all' || q.split === split);
}

function toolRanking(root: string, question: string): Ranking {
  const start = performance.now();
  const hits = SemanticSearchEngine.search(root, question, RANK_DEPTH * 3);
  const ms = performance.now() - start;
  const files: string[] = [];
  hits.forEach(h => {
    const rel = path.relative(root, h.filePath).replace(/\\/g, '/');
    if (!files.includes(rel)) files.push(rel);
  });
  return { files: files.slice(0, RANK_DEPTH), ms };
}

/**
 * What an agent does without an index: grep for the question's words and open the files with the most matches.
 * Files matching more distinct words rank first; ties break on the number of matching lines.
 */
function grepRanking(root: string, sourceFiles: string[], contents: Map<string, string>, question: string): Ranking {
  const start = performance.now();
  const words = TextNormalizer.queryContentWords(question).filter(w => w.length > 2);
  const scored = sourceFiles.map(rel => {
    const lines = (contents.get(rel) || '').toLowerCase().split('\n');
    const matched = words.filter(w => lines.some(l => l.includes(w))).length;
    const matchingLines = lines.filter(l => words.some(w => l.includes(w))).length;
    return { rel, score: matched * 1000 + matchingLines };
  });
  const files = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel)).map(s => s.rel);
  return { files: files.slice(0, RANK_DEPTH), ms: performance.now() - start };
}

function scoreQuestion(q: Question, ranking: string[], fileTokens: Map<string, number>): QuestionResult {
  const expected = new Set(q.files);
  const firstIdx = ranking.findIndex(f => expected.has(f));
  const recallAt10 = q.files.filter(f => ranking.slice(0, 10).includes(f)).length / q.files.length;

  // Locate is answered once any expected file is opened; a feature once all of them are
  let tokens = 0;
  let tokensToAnswer: number | null = null;
  const seen = new Set<string>();
  for (const file of ranking) {
    tokens += fileTokens.get(file) || 0;
    if (expected.has(file)) seen.add(file);
    if (q.type === 'locate' ? seen.size > 0 : seen.size === expected.size) {
      tokensToAnswer = tokens;
      break;
    }
  }

  return { id: q.id, type: q.type, firstHit: firstIdx >= 0 ? firstIdx + 1 : null, recallAt10: round(recallAt10), tokensToAnswer };
}

function summarize(results: QuestionResult[]): MethodSummary {
  const locate = results.filter(r => r.type === 'locate');
  const feature = results.filter(r => r.type === 'feature');
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  return {
    locate: {
      count: locate.length,
      hitAt1: round(mean(locate.map(r => (r.firstHit === 1 ? 1 : 0)))),
      hitAt5: round(mean(locate.map(r => (r.firstHit !== null && r.firstHit <= 5 ? 1 : 0)))),
      mrr: round(mean(locate.map(r => (r.firstHit ? 1 / r.firstHit : 0)))),
      medianTokens: median(locate.filter(r => r.tokensToAnswer !== null).map(r => r.tokensToAnswer!)),
      answeredAt20: round(mean(locate.map(r => (r.tokensToAnswer !== null ? 1 : 0))))
    },
    feature: {
      count: feature.length,
      recallAt10: round(mean(feature.map(r => r.recallAt10))),
      fullyCoveredAt20: round(mean(feature.map(r => (r.tokensToAnswer !== null ? 1 : 0)))),
      medianTokens: median(feature.filter(r => r.tokensToAnswer !== null).map(r => r.tokensToAnswer!))
    }
  };
}

function benchRepo(repo: CorpusRepo, split: string): RepoReport | null {
  const questions = loadQuestions(repo, split);
  if (questions.length === 0) return null;
  const root = ensureRepo(repo);

  // grep sees every tracked text file, as an agent would; the tool sees only what it indexes, so files it
  // cannot index count against it instead of being dropped from the ground truth
  const trackedFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(rel => {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).size > 500 * 1024) return false;
      return !fs.readFileSync(abs).subarray(0, 8000).includes(0);
    });
  const contents = new Map(trackedFiles.map(rel => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]));
  const fileTokens = new Map(trackedFiles.map(rel => [rel, tokensOf(contents.get(rel)!)]));
  const indexed = new Set(ASTExtractor.listSourceFiles(root).map(e => path.relative(root, e.filePath).replace(/\\/g, '/')));

  const missing = questions.flatMap(q => q.files.filter(f => !contents.has(f)).map(f => `${q.id}: ${f}`));
  if (missing.length > 0) {
    throw new Error(`Ground-truth files missing from ${repo.name}:\n  ${missing.join('\n  ')}`);
  }
  const notIndexed = Array.from(new Set(questions.flatMap(q => q.files.filter(f => !indexed.has(f))))).sort();

  // Cold index build, measured from scratch
  fs.rmSync(path.join(root, '.codebase'), { recursive: true, force: true });
  const buildStart = performance.now();
  SemanticSearchEngine.buildIndex(root);
  const buildMs = Math.round(performance.now() - buildStart);
  const bytes = fs.statSync(path.join(root, '.codebase', 'embeddings.json')).size;

  const tool: QuestionResult[] = [];
  const grep: QuestionResult[] = [];
  const slice: SliceResult[] = [];
  const latencies: number[] = [];
  questions.forEach(q => {
    const t = toolRanking(root, q.question);
    latencies.push(t.ms);
    tool.push(scoreQuestion(q, t.files, fileTokens));
    grep.push(scoreQuestion(q, grepRanking(root, trackedFiles, contents, q.question).files, fileTokens));
    if (q.type === 'feature') {
      const s = FeatureSliceBuilder.build(root, q.question);
      const inSlice = new Set(s.files.map(f => f.file));
      const hits = q.files.filter(f => inSlice.has(f)).length;
      slice.push({
        id: q.id,
        recall: round(hits / q.files.length),
        precision: round(inSlice.size ? hits / inSlice.size : 0),
        covered: hits === q.files.length,
        tokens: s.tokens,
        files: inSlice.size
      });
    }
  });

  return {
    files: indexed.size,
    trackedFiles: trackedFiles.length,
    notIndexed,
    index: { buildMs, bytes },
    latency: { p50: Math.round(percentile(latencies, 50)), p95: Math.round(percentile(latencies, 95)) },
    tool: summarize(tool),
    grep: summarize(grep),
    slice: summarizeSlices(slice),
    questions: { tool, grep, slice }
  };
}

function summarizeSlices(results: SliceResult[]): SliceSummary {
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  return {
    count: results.length,
    recall: round(mean(results.map(r => r.recall))),
    precision: round(mean(results.map(r => r.precision))),
    fullyCovered: round(mean(results.map(r => (r.covered ? 1 : 0)))),
    medianTokens: median(results.map(r => r.tokens)),
    medianFiles: median(results.map(r => r.files))
  };
}

function toMarkdown(report: BenchReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const tok = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));
  const row = (name: string, method: 'tool' | 'grep', s: MethodSummary) =>
    `| ${name} | ${method === 'tool' ? 'codebase-trainer' : 'grep baseline'} | ${pct(s.locate.hitAt1)} | ${pct(s.locate.hitAt5)} | ${s.locate.mrr.toFixed(2)} | ${tok(s.locate.medianTokens)} | ${pct(s.feature.recallAt10)} | ${tok(s.feature.medianTokens)} |`;

  const lines = [
    `# Benchmark ${report.label} (${report.split} questions, ${report.date.slice(0, 10)})`,
    '',
    '| Repo | Method | Locate hit@1 | Locate hit@5 | Locate MRR | Locate median tokens | Feature recall@10 | Feature median tokens |',
    '|---|---|---|---|---|---|---|---|'
  ];
  Object.entries(report.repos).forEach(([name, r]) => {
    lines.push(row(name, 'tool', r.tool), row(name, 'grep', r.grep));
  });
  lines.push(row('**all**', 'tool', report.overall.tool), row('**all**', 'grep', report.overall.grep));
  const sliceRow = (name: string, s: SliceSummary) =>
    `| ${name} | ${s.count} | ${pct(s.recall)} | ${pct(s.precision)} | ${pct(s.fullyCovered)} | ${tok(s.medianTokens)} | ${s.medianFiles ?? '—'} |`;
  lines.push(
    '',
    '**feature_slice** on feature questions (one call, default 6,000-token budget):',
    '',
    '| Repo | Questions | Recall | Precision | Fully covered | Median tokens | Median files |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(report.repos).map(([name, r]) => sliceRow(name, r.slice)),
    sliceRow('**all**', report.overall.slice)
  );
  lines.push('', '| Repo | Indexed / tracked files | Index build | Index size | Search p50 | Search p95 | Ground-truth files not indexed |', '|---|---|---|---|---|---|---|');
  Object.entries(report.repos).forEach(([name, r]) => {
    lines.push(`| ${name} | ${r.files} / ${r.trackedFiles} | ${(r.index.buildMs / 1000).toFixed(1)} s | ${(r.index.bytes / 1024 / 1024).toFixed(1)} MB | ${r.latency.p50} ms | ${r.latency.p95} ms | ${r.notIndexed.length ? r.notIndexed.map(f => `\`${f}\``).join(', ') : 'none'} |`);
  });
  lines.push(
    '',
    'Tokens = tokens an agent reads opening the ranked files in order until a locate question has one expected file, or a feature question has all of them (≈ 4 characters per token). Median over answered questions only; see the JSON for unanswered counts.'
  );
  return lines.join('\n') + '\n';
}

function compare(current: BenchReport, baselinePath: string): string[] {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BenchReport;
  const get = (s: MethodSummary, key: string) => key.split('.').reduce<any>((o, k) => o?.[k], s) as number;
  return GUARDED.flatMap(key => {
    const before = get(baseline.overall.tool, key);
    const after = get(current.overall.tool, key);
    return after < before - MAX_DROP ? [`${key}: ${before} -> ${after}`] : [];
  });
}

async function main() {
  const parser = (await TreeSitter.init()) ? 'tree-sitter' : 'regex';
  console.error(`Parser: ${parser}`);
  const split = args.split || 'all';
  const only = args.repos ? new Set(args.repos.split(',')) : null;
  const label = args.label || JSON.parse(fs.readFileSync(path.join(BENCH_DIR, '..', 'package.json'), 'utf8')).version;

  const repos: Record<string, RepoReport> = {};
  loadCorpus().filter(r => !only || only.has(r.name)).forEach(repo => {
    console.error(`Benchmarking ${repo.name}...`);
    const result = benchRepo(repo, split);
    if (result) repos[repo.name] = result;
    else console.error(`  no ${split} questions in bench/questions/${repo.name}.yaml, skipped`);
  });
  if (Object.keys(repos).length === 0) throw new Error('No questions found; add bench/questions/<repo>.yaml files.');

  const all = Object.values(repos);
  const report: BenchReport = {
    label,
    date: new Date().toISOString(),
    split,
    repos,
    overall: {
      tool: summarize(all.flatMap(r => r.questions.tool)),
      grep: summarize(all.flatMap(r => r.questions.grep)),
      slice: summarizeSlices(all.flatMap(r => r.questions.slice))
    }
  };

  const outDir = path.join(BENCH_DIR, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${label}-${split}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(`${base}.md`, toMarkdown(report), 'utf8');
  console.log(toMarkdown(report));

  if (args['write-baseline'] === 'true') {
    const baselineFile = path.join(BENCH_DIR, `baseline-${split}.json`);
    fs.writeFileSync(baselineFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.error(`Wrote ${path.relative(process.cwd(), baselineFile)}`);
  }
  if (args.baseline) {
    const regressions = compare(report, args.baseline);
    if (regressions.length > 0) {
      console.error(`Benchmark regression (more than ${MAX_DROP} drop):\n  ${regressions.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.error(`No regression against ${args.baseline}.`);
    }
  }
}

await main();
