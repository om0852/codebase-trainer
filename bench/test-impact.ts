import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { TestImpactAnalyzer } from '../src/graph/testImpact.js';
import { BENCH_DIR } from './corpus.js';

/**
 * Test-impact recall by mutation, on this repository: for each source file, make it throw when loaded, run every
 * test file, and check that each test file that fails was selected. A missed failing test is a test the selection
 * would have wrongly skipped. Runs on a copy of the repo, so the working tree is never modified.
 * `tsx bench/test-impact.ts [--label=x] [--files=src/a.ts,src/b.ts]`
 *
 * Load failures break every test that reaches the file, so this measures recall (nothing needed is skipped) and
 * how much of the suite is skipped; it does not measure precision.
 */

const repo = path.join(BENCH_DIR, '..');
const label = process.argv.find(a => a.startsWith('--label='))?.split('=')[1]
  ?? JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const only = process.argv.find(a => a.startsWith('--files='))?.split('=')[1]?.split(',');
await TreeSitter.init();

const sources = only ?? fs.readdirSync(path.join(repo, 'src'), { recursive: true, encoding: 'utf8' })
  .map(f => `src/${f.replace(/\\/g, '/')}`)
  .filter(f => f.endsWith('.ts') && !f.startsWith('src/cli/') && !f.startsWith('src/mcp/'));
const testFiles = fs.readdirSync(path.join(repo, 'tests')).filter(f => f.endsWith('.test.ts')).map(f => `tests/${f}`);

// Copy the sources and tests; share node_modules through a directory link
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-trainer-test-impact-'));
['src', 'tests', 'grammars'].forEach(dir => fs.cpSync(path.join(repo, dir), path.join(work, dir), { recursive: true }));
['package.json', 'tsconfig.json'].forEach(file => fs.copyFileSync(path.join(repo, file), path.join(work, file)));
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(work, 'node_modules'), 'junction');

const tsx = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const passes = (test: string) => new Promise<boolean>(resolve => {
  const child = spawn(process.execPath, [tsx, '--test', test], { cwd: work, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill(), 300_000);
  child.on('exit', code => { clearTimeout(timer); resolve(code === 0); });
});
// Test files in parallel, a few at a time
const failingTests = async (files = testFiles): Promise<string[]> => {
  const failing: string[] = [];
  const queue = [...files];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let test = queue.shift(); test; test = queue.shift()) if (!(await passes(test))) failing.push(test);
  }));
  return failing.sort();
};

const rows: string[] = [];
const missed: string[] = [];
let totalFailing = 0, totalCaught = 0, totalSelected = 0;
try {
  const baseline = await failingTests();
  if (baseline.length > 0) throw new Error(`Tests fail before mutation: ${baseline.join(', ')}`);

  for (const source of sources) {
    const abs = path.join(work, source);
    const original = fs.readFileSync(abs, 'utf8');
    const selected = new Set(TestImpactAnalyzer.forTargets(work, [source]).tests.map(t => t.file));
    fs.writeFileSync(abs, `${original}\nthrow new Error('test-impact mutant');\n`);
    let failing = await failingTests();
    // A test that fails outside the selection is re-run alone, so a timing flake under parallel load is not counted
    const unexpected = failing.filter(t => !selected.has(t));
    const confirmed = new Set(unexpected.length > 0 ? await failingTests(unexpected) : []);
    failing = failing.filter(t => selected.has(t) || confirmed.has(t));
    fs.writeFileSync(abs, original);

    const caught = failing.filter(t => selected.has(t));
    failing.filter(t => !selected.has(t)).forEach(t => missed.push(`${source}: ${t} failed but was not selected`));
    totalFailing += failing.length;
    totalCaught += caught.length;
    totalSelected += selected.size;
    rows.push(`| ${source} | ${selected.size} | ${failing.length} | ${caught.length} |`);
    console.log(`${source}: selected ${selected.size}, failing ${failing.length}, caught ${caught.length}`);
  }
} finally {
  // Remove the link itself first, and never recurse into the copy while it might still reach the real node_modules
  const link = path.join(work, 'node_modules');
  try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* already gone */ } }
  if (!fs.existsSync(link)) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`Left ${work} in place: could not remove its node_modules link.`);
}

const lines = [
  `# Test impact ${label}`,
  '',
  `${sources.length} source files of this repo, each made to throw on load; ${testFiles.length} test files.`,
  '',
  '| Source file | Tests selected | Tests that failed | Failing tests selected |',
  '|---|---|---|---|',
  ...rows,
  `| **all** | ${(totalSelected / sources.length).toFixed(1)} avg of ${testFiles.length} | ${totalFailing} | ${totalCaught} (recall ${totalFailing ? Math.round((totalCaught / totalFailing) * 100) : 100}%) |`,
  '',
  missed.length > 0 ? 'Missed:\n\n' + missed.map(m => `- ${m}`).join('\n') : 'No failing test was left out of the selection.',
  '',
  'A load failure breaks every test that reaches the file, so selected-but-passing tests show only where a test reaches the file without loading it. This measures recall and suite reduction, not precision.'
];
fs.mkdirSync(path.join(BENCH_DIR, 'results'), { recursive: true });
fs.writeFileSync(path.join(BENCH_DIR, 'results', `${label}-test-impact.md`), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
