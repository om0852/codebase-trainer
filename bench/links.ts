import * as fs from 'fs';
import * as path from 'path';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { CallSiteExtractor } from '../src/flow/callSites.js';
import { TRPC_REQUEST_OPERATIONS } from '../src/flow/adapters.js';
import { ContractDriftDetector } from '../src/microservices/contractDrift.js';
import { extractCodeFacts } from '../src/parsing/codeFacts.js';
import { BENCH_DIR, ensureRepo, loadCorpus } from './corpus.js';

/**
 * Cross-stack linking report: how many client request sites (fetch/axios/wrappers and tRPC calls) are linked to a
 * server handler, plus routes found and data-layer edges. `tsx bench/links.ts [--label=x]`
 */

const label = process.argv.find(a => a.startsWith('--label='))?.split('=')[1]
  ?? JSON.parse(fs.readFileSync(path.join(BENCH_DIR, '..', 'package.json'), 'utf8')).version;
const parser = (await TreeSitter.init()) ? 'tree-sitter' : 'regex';

const rows: string[] = [];
let totalSites = 0;
let totalLinked = 0;
for (const repo of loadCorpus()) {
  const root = ensureRepo(repo);
  const rel = (f: string) => f.replace(/\\/g, '/');
  const facts = ASTExtractor.scanDirectory(root);
  const edges = CallSiteExtractor.extractEdges(root, facts);

  // Request sites: REST client calls plus tRPC calls that perform a request
  const sites = new Set(ContractDriftDetector.extractClientCalls(root).map(c => `${rel(c.filePath)}:${c.line}`));
  facts.forEach(f => {
    const content = ASTExtractor.readSourceFile(f.filePath);
    const tree = content ? extractCodeFacts(f.filePath, content) : null;
    tree?.calls.forEach(call => {
      const parts = call.callee.split('.');
      if (parts.length >= 4 && /^(trpc|api|utils)$/.test(parts[0]) && TRPC_REQUEST_OPERATIONS.has(parts[parts.length - 1])) {
        sites.add(`${rel(path.relative(root, f.filePath))}:${call.line}`);
      }
    });
  });
  const linked = new Set(edges.filter(e => e.kind === 'http').map(e => `${e.from.filePath}:${e.from.line}`));
  const linkedSites = [...sites].filter(s => linked.has(s)).length;
  totalSites += sites.size;
  totalLinked += linkedSites;

  const count = (kind: string) => edges.filter(e => e.kind === kind && e.from.filePath !== e.to.filePath).length;
  const routes = ContractDriftDetector.extractServerEndpoints(root).length;
  const sameFile = edges.filter(e => e.from.filePath === e.to.filePath).length;
  const pct = sites.size ? `${Math.round((linkedSites / sites.size) * 100)}%` : '—';
  rows.push(`| ${repo.name} | ${sites.size} | ${linkedSites} (${pct}) | ${routes} | ${count('data')} | ${count('call')} | ${sameFile} |`);
}

const lines = [
  `# Cross-stack linking ${label} (${parser})`,
  '',
  '| Repo | Client request sites | Linked to a handler | Server routes | Data-layer edges | Cross-file calls | Same-file calls |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  `| **all** | ${totalSites} | ${totalLinked} (${totalSites ? Math.round((totalLinked / totalSites) * 100) : 0}%) | | | | |`,
  '',
  'Request sites are fetch/axios/wrapper calls and tRPC calls that perform a request (queryOptions, mutationOptions, useQuery, ...).'
];
const outDir = path.join(BENCH_DIR, 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${label}-links.md`), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
