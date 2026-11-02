import * as fs from 'fs';
import * as path from 'path';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { PermissionMapBuilder } from '../src/security/permissionMap.js';
import { BENCH_DIR, ensureRepo, loadCorpus } from './corpus.js';

/**
 * Permission map report: how many routes get the right auth requirement, and how many findings are real,
 * against the hand labels in bench/permissions.json. `tsx bench/permissions.ts [--label=x]`
 */

interface RepoLabels { none: string[]; optional: string[]; findings: string[] }

const label = process.argv.find(a => a.startsWith('--label='))?.split('=')[1]
  ?? JSON.parse(fs.readFileSync(path.join(BENCH_DIR, '..', 'package.json'), 'utf8')).version;
const parser = (await TreeSitter.init()) ? 'tree-sitter' : 'regex';
const labels: Record<string, RepoLabels> = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'permissions.json'), 'utf8')).repos;

const rows: string[] = [];
const wrong: string[] = [];
const total = { routes: 0, correct: 0, findings: 0, truePositives: 0, expected: 0 };
for (const repo of loadCorpus()) {
  const expected = labels[repo.name];
  if (!expected) continue;
  const map = PermissionMapBuilder.build(ensureRepo(repo));
  const truth = (key: string) => expected.none.includes(key) ? 'none' : expected.optional.includes(key) ? 'optional' : 'required';
  let correct = 0;
  map.routes.forEach(r => {
    const key = `${r.method} ${r.endpoint}`;
    if (r.auth === truth(key)) correct++;
    else wrong.push(`${repo.name}: ${key} mapped as ${r.auth}, actually ${truth(key)}`);
  });
  const found = map.findings.map(f => `${f.rule} ${f.method} ${f.endpoint}`);
  const truePositives = found.filter(f => expected.findings.includes(f)).length;
  found.filter(f => !expected.findings.includes(f)).forEach(f => wrong.push(`${repo.name}: false positive ${f}`));
  expected.findings.filter(f => !found.includes(f)).forEach(f => wrong.push(`${repo.name}: missed ${f}`));

  total.routes += map.routes.length;
  total.correct += correct;
  total.findings += found.length;
  total.truePositives += truePositives;
  total.expected += expected.findings.length;
  rows.push(`| ${repo.name} | ${map.routes.length} | ${correct} | ${map.summary.required} / ${map.summary.optional} / ${map.summary.none} | ${found.length} | ${found.length - truePositives} | ${expected.findings.length - truePositives} |`);
}

const lines = [
  `# Permission map ${label} (${parser})`,
  '',
  '| Repo | Routes | Auth correct | Required / optional / none | Findings | False positives | Missed |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  `| **all** | ${total.routes} | ${total.correct} (${total.routes ? Math.round((total.correct / total.routes) * 100) : 0}%) | | ${total.findings} | ${total.findings - total.truePositives} | ${total.expected - total.truePositives} |`,
  '',
  wrong.length > 0 ? 'Mismatches:\n\n' + wrong.map(w => `- ${w}`).join('\n') : 'No mismatches against the labels.',
  '',
  'Labels (bench/permissions.json) were written by reading each handler and its middleware. These repos use no scopes, so only route-without-auth is exercised here; the scope rules are covered by fixtures in tests/permissionMap.test.ts.'
];
const outDir = path.join(BENCH_DIR, 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${label}-permissions.md`), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
