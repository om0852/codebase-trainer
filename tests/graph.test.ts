import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { CallGraphAnalyzer } from '../src/graph/callGraph.js';
import { ImpactAnalyzer } from '../src/graph/impactAnalyzer.js';
import { ImportResolver } from '../src/graph/importResolver.js';
import { PageRankCalculator } from '../src/graph/pageRank.js';
import { ConventionMiner } from '../src/miner/conventionMiner.js';
import { DashboardGenerator } from '../src/ui/dashboardGenerator.js';
import { repoPath, withFixture, withRepoLock } from './helpers.js';

test('CallGraphAnalyzer maps function nodes in the repo', async () => {
  await withRepoLock(() => {
    const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
    assert.ok(graph.nodes && typeof graph.nodes === 'object', 'Call graph should expose a node map');
  });
});

test('ImpactAnalyzer traces a repo file', async () => {
  await withRepoLock(() => {
    const impact = ImpactAnalyzer.analyzeImpact(repoPath, 'astExtractor.ts');
    assert.ok(Array.isArray(impact.affectedRoutes), 'Impact analysis should list affected routes');
  });
});

test('PageRank ranks files and symbols in the repo', async () => {
  await withRepoLock(() => {
    const prResult = PageRankCalculator.calculate(repoPath);
    assert.ok(prResult.topFiles.length > 0, 'Should have ranked files');
    assert.ok(prResult.topSymbols.length > 0, 'Should have ranked symbols');
  });
});

test('dashboard HTML embeds and initialises a Mermaid graph', async () => {
  await withRepoLock(() => {
    const conventions = ConventionMiner.loadConventions(repoPath)
      || ConventionMiner.generateConventions(repoPath, ASTExtractor.scanDirectory(repoPath));
    const callGraph = CallGraphAnalyzer.analyzeGraph(repoPath);
    const dashboardPath = DashboardGenerator.generateHTML(repoPath, conventions, callGraph);
    assert.ok(fs.existsSync(dashboardPath), 'Dashboard HTML file should exist');
    const dashboardHTML = fs.readFileSync(dashboardPath, 'utf8');
    assert.ok(dashboardHTML.includes('graph TD'), 'Dashboard should contain Mermaid graph definition');
    assert.ok(dashboardHTML.includes('mermaid.initialize'), 'Dashboard should initialize Mermaid');
  });
});

const importFixture: Record<string, string> = {
  'tsconfig.json': `{
  // comments and trailing commas are allowed in tsconfig
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, "homepage": "https://example.test/*" },
}`,
  'src/app/page.tsx': `import React from 'react';
import {
  getLinks,
  createLink
} from '@/store/links';
import type { Link } from '../types';
export default function Page() { return getLinks(); }
`,
  'src/store/links.ts': `import { api } from '../api/client.js';
export * from './helpers';
const legacy = require('./legacy');
export async function getLinks() { const lazy = await import('./lazy'); return api('/api/links'); }
`,
  'src/store/helpers/index.ts': `import { getLinks } from '../links';
export const refresh = () => getLinks();
`,
  'src/store/legacy.cjs': `module.exports = {};\n`,
  'src/store/lazy.ts': `export const lazy = true;\n`,
  'src/api/client.ts': `export function api(url: string) { return fetch(url); }\n`,
  'src/types.ts': `export interface Link { id: string }\n`,
  'py/pkg/__init__.py': '',
  'py/pkg/a.py': `from .b import thing\nimport os\n`,
  'py/pkg/b.py': `thing = 1\n`
};

test('import resolution: ESM imports, tsconfig aliases, require, dynamic import and Python', async () => {
  await withFixture(importFixture, root => {
    const abs = (rel: string) => path.join(root, rel);
    const facts = ASTExtractor.scanDirectory(root);
    const pageFact = facts.find(f => f.filePath === abs('src/app/page.tsx'));
    assert.ok(pageFact, 'Fixture page should be indexed');
    assert.deepStrictEqual([...pageFact.importedModules].sort(), ['../types', '@/store/links', 'react'], 'Should extract multi-line, type-only and default ESM imports');

    const importGraph = ImportResolver.buildImportGraph(root, facts);
    assert.deepStrictEqual([...importGraph[abs('src/app/page.tsx')]].sort(), [abs('src/store/links.ts'), abs('src/types.ts')].sort(), 'Should resolve tsconfig alias and relative import, dropping external packages');
    assert.deepStrictEqual([...importGraph[abs('src/store/links.ts')]].sort(), [
      abs('src/api/client.ts'), abs('src/store/helpers/index.ts'), abs('src/store/lazy.ts'), abs('src/store/legacy.cjs')
    ].sort(), 'Should resolve .js -> .ts, index files, re-exports, require() and dynamic import()');
    assert.deepStrictEqual(importGraph[abs('py/pkg/a.py')], [abs('py/pkg/b.py')], 'Should resolve Python relative imports');
  }, 'cb-trainer-imports-');
});

test('import cycles are detected exactly once', async () => {
  await withFixture(importFixture, root => {
    const abs = (rel: string) => path.join(root, rel);
    const importGraph = ImportResolver.buildImportGraph(root, ASTExtractor.scanDirectory(root));
    const cycles = CallGraphAnalyzer.findImportCycles(importGraph);
    assert.strictEqual(cycles.length, 1, 'Should detect exactly one import cycle');
    assert.deepStrictEqual([...cycles[0]].sort(), [abs('src/store/helpers/index.ts'), abs('src/store/links.ts')].sort());
  }, 'cb-trainer-imports-');
});

test('change impact follows the reverse import graph, for files and symbols', async () => {
  await withFixture(importFixture, root => {
    const fileImpact = ImpactAnalyzer.analyzeImpact(root, 'src/api/client.ts');
    assert.deepStrictEqual(fileImpact.directDependents, ['src/store/links.ts'], 'Only the real importer is a direct dependent');
    assert.deepStrictEqual([...fileImpact.transitiveDependents].sort(), ['src/app/page.tsx', 'src/store/helpers/index.ts'], 'Transitive dependents follow the reverse import graph');

    const symbolImpact = ImpactAnalyzer.analyzeImpact(root, 'api');
    assert.deepStrictEqual(symbolImpact.directDependents, ['src/store/links.ts'], 'Symbol targets resolve to their declaring file');
  }, 'cb-trainer-imports-');
});

test('tsconfig extends arrays and package-based extends resolve aliases without crashing', async () => {
  await withFixture({
    // TypeScript 5+ allows an array; package names (non-relative) are skipped, relative entries are merged in order
    'apps/web/tsconfig.json': '{ "extends": ["@acme/tsconfig/base.json", "./tsconfig.paths.json"], "compilerOptions": {} }',
    'apps/web/tsconfig.paths.json': '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }',
    'apps/web/src/page.ts': "import { db } from '~/lib/db';\nexport const page = db;\n",
    'apps/web/src/lib/db.ts': 'export const db = 1;\n'
  }, root => {
    const graph = ImportResolver.buildImportGraph(root, ASTExtractor.scanDirectory(root));
    const page = path.join(root, 'apps', 'web', 'src', 'page.ts');
    assert.deepEqual(graph[page], [path.join(root, 'apps', 'web', 'src', 'lib', 'db.ts')]);
  });
});
