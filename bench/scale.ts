import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { SemanticSearchEngine } from '../src/semantic/searchEngine.js';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { FeatureSliceBuilder } from '../src/context/featureSlice.js';
import { ImpactAnalyzer } from '../src/graph/impactAnalyzer.js';
import { RepoWatch } from '../src/watcher/repoWatch.js';
import { BENCH_DIR } from './corpus.js';

/**
 * Scale benchmark on a generated repo (default 10,000 files): index build time and size, then warm latency in one
 * process (as the MCP server runs) for search, feature_slice and impact, plus a no-change freshness check.
 * `tsx bench/scale.ts [--files=10000] [--label=x]`
 *
 * The repo is synthetic: a Next.js + Prisma app of many similar feature folders, with imports, routes, client
 * fetches and data access, so every analysis has real work to do. Its vocabulary is generated, so the numbers say
 * nothing about ranking quality; they measure speed and size only.
 */

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [key, value] = a.replace(/^--/, '').split('=');
  return [key, value ?? 'true'];
}));
const fileCount = Number(args.files ?? 10000);
const label = args.label ?? JSON.parse(fs.readFileSync(path.join(BENCH_DIR, '..', 'package.json'), 'utf8')).version;
const root = path.join(BENCH_DIR, '.cache', `synthetic-${fileCount}`);

// Deterministic generator
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
const NOUNS = ['invoice', 'customer', 'order', 'shipment', 'ledger', 'coupon', 'refund', 'tenant', 'webhook', 'report', 'session', 'quota', 'audit', 'payment', 'catalog', 'review', 'ticket', 'warehouse', 'subscription', 'notification'];
const VERBS = ['create', 'update', 'archive', 'approve', 'sync', 'export', 'import', 'validate', 'merge', 'schedule', 'notify', 'reconcile'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function generate(): void {
  if (fs.existsSync(path.join(root, '.generated'))) return;
  fs.rmSync(root, { recursive: true, force: true });
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  const models = NOUNS.map(cap);
  write('prisma/schema.prisma', models.map(m => `model ${m} {\n  id String @id\n  name String\n  createdAt DateTime\n}\n`).join('\n'));
  write('lib/db.ts', "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\n");
  write('lib/http.ts', 'export async function request<T>(url: string, init?: RequestInit): Promise<T> {\n  const res = await fetch(url, init);\n  if (!res.ok) throw new Error(`Request failed: ${res.status}`);\n  return res.json() as Promise<T>;\n}\n');
  write('package.json', JSON.stringify({ name: 'synthetic', devDependencies: { vitest: '^2.0.0' } }));

  // Each feature folder: route, service, client, component, helper and test files
  const perFeature = 6;
  const features = Math.ceil((fileCount - 4) / perFeature);
  for (let f = 0; f < features; f++) {
    const noun = NOUNS[f % NOUNS.length];
    const model = cap(noun);
    const verb = pick(VERBS);
    const name = `${noun}${f}`;
    const dir = `features/${name}`;
    const fn = `${verb}${cap(name)}`;
    const body = (n: number) => Array.from({ length: n }, (_, i) =>
      `  const step${i} = ${pick(['input', 'record', 'payload', 'result'])}.${pick(['amount', 'status', 'owner', 'region', 'total'])} ?? ${Math.floor(rand() * 100)}; // ${pick(VERBS)} ${pick(NOUNS)} ${pick(NOUNS)}`
    ).join('\n');
    write(`app/api/${name}/route.ts`, `import { ${fn} } from '../../../${dir}/service';\n\nexport async function POST(req: Request) {\n  const input = await req.json();\n  return Response.json(await ${fn}(input));\n}\n\nexport async function GET() {\n  return Response.json(await ${fn}({}));\n}\n`);
    write(`${dir}/service.ts`, `import { db } from '../../lib/db';\nimport { normalize${cap(name)} } from './helpers';\n\n/** ${cap(verb)}s a ${noun} and records it. */\nexport async function ${fn}(input: Record<string, unknown>) {\n  const record = normalize${cap(name)}(input);\n${body(12)}\n  return db.${noun}.create({ data: { name: String(record.name ?? '${name}') } });\n}\n\nexport async function list${cap(name)}s() {\n  return db.${noun}.findMany({ take: 50 });\n}\n`);
    write(`${dir}/helpers.ts`, `export function normalize${cap(name)}(input: Record<string, unknown>) {\n  const payload = { ...input };\n${body(20)}\n  return payload;\n}\n`);
    write(`${dir}/client.ts`, `import { request } from '../../lib/http';\n\nexport function ${verb}${cap(name)}Request(input: unknown) {\n  return request('/api/${name}', { method: 'POST', body: JSON.stringify(input) });\n}\n`);
    write(`${dir}/${cap(name)}Panel.tsx`, `import { ${verb}${cap(name)}Request } from './client';\n\nexport function ${cap(name)}Panel() {\n  const onSubmit = () => ${verb}${cap(name)}Request({ name: '${name}' });\n  return <button onClick={onSubmit}>${cap(verb)} ${noun}</button>;\n}\n`);
    write(`${dir}/service.test.ts`, `import { test } from 'vitest';\nimport { ${fn} } from './service';\n\ntest('${fn}', async () => {\n  await ${fn}({ name: 'x' });\n});\n`);
  }
  write('.generated', `${fileCount}\n`);
}

const time = <T>(fn: () => T): [T, number] => {
  const start = performance.now();
  const value = fn();
  return [value, performance.now() - start];
};
const timeAsync = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
};
const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))];
const ms = (n: number) => `${Math.round(n).toLocaleString('en-US')} ms`;

await TreeSitter.init();
generate();
const files = ASTExtractor.listSourceFiles(root).length;
console.error(`Synthetic repo: ${files} indexable files at ${root}`);

fs.rmSync(path.join(root, '.codebase'), { recursive: true, force: true });
const [, buildMs] = time(() => SemanticSearchEngine.buildIndex(root));
const indexBytes = fs.readdirSync(path.join(root, '.codebase')).reduce((sum, f) => sum + fs.statSync(path.join(root, '.codebase', f)).size, 0);
console.error(`Index built in ${ms(buildMs)}, ${(indexBytes / 1e6).toFixed(1)} MB`);

// A one-shot CLI search in a fresh process: loads the stored index and PageRank scores, nothing else
const cliStart = performance.now();
const cli = spawnSync(process.execPath, [path.join(BENCH_DIR, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(BENCH_DIR, '..', 'src', 'cli', 'index.ts'), 'search', 'approve invoice amount', '-d', root, '--json'], { encoding: 'utf8' });
const cliMs = performance.now() - cliStart;
if (cli.status !== 0) console.error(cli.stderr);

// As the MCP server does: watch the repo so tool calls patch the file listing instead of walking it
RepoWatch.start(root);

const queries = Array.from({ length: 30 }, (_, i) => `${pick(VERBS)} ${pick(NOUNS)} ${i % 3 === 0 ? pick(['amount', 'region', 'status']) : ''}`.trim());
const [, firstSearchMs] = await timeAsync(() => SemanticSearchEngine.searchWithStatusAsync(root, queries[0], 5));
const searchMs: number[] = [];
for (const q of queries) searchMs.push((await timeAsync(() => SemanticSearchEngine.searchWithStatusAsync(root, q, 5)))[1]);
const [, freshnessMs] = time(() => SemanticSearchEngine.ensureFreshIndex(root));

const sliceMs: number[] = [];
for (const q of queries.slice(0, 5)) sliceMs.push(time(() => FeatureSliceBuilder.build(root, q))[1]);
const impactMs: number[] = [];
for (let i = 0; i < 5; i++) impactMs.push(time(() => ImpactAnalyzer.analyzeImpact(root, `features/${NOUNS[i]}${i}/helpers.ts`))[1]);

// One edited file, then the next search (incremental refresh)
const edited = path.join(root, 'features', `${NOUNS[1]}1`, 'helpers.ts');
fs.appendFileSync(edited, `// edited ${Date.now()}\n`);
const [, afterEditMs] = await timeAsync(() => SemanticSearchEngine.searchWithStatusAsync(root, queries[1], 5));

const lines = [
  `# Scale ${label} (${files.toLocaleString('en-US')} files)`,
  '',
  '| Measure | Result | Budget |',
  '|---|---|---|',
  `| Index build (cold) | ${ms(buildMs)} | < 60,000 ms |`,
  `| Index size on disk | ${(indexBytes / 1e6).toFixed(1)} MB | < 100 MB |`,
  `| \`cb-trainer search\` in a new process (CLI startup included) | ${ms(cliMs)} | |`,
  `| First search after the build, same process | ${ms(firstSearchMs)} | |`,
  `| Search, warm p50 / p95 | ${ms(pct(searchMs, 50))} / ${ms(pct(searchMs, 95))} | p95 < 150 ms |`,
  `| Freshness check, nothing changed | ${ms(freshnessMs)} | |`,
  `| Search after editing one file | ${ms(afterEditMs)} | |`,
  `| feature_slice, warm p50 / max | ${ms(pct(sliceMs, 50))} / ${ms(Math.max(...sliceMs))} | |`,
  `| impact, warm p50 / max | ${ms(pct(impactMs, 50))} / ${ms(Math.max(...impactMs))} | |`,
  '',
  'Warm = later calls in the same process with the file watcher on, as in the MCP server. Synthetic code: speed and size only, not ranking quality.'
];
fs.mkdirSync(path.join(BENCH_DIR, 'results'), { recursive: true });
fs.writeFileSync(path.join(BENCH_DIR, 'results', `${label}-scale-${fileCount}.md`), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
