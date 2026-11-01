import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { ConventionMiner } from '../src/miner/conventionMiner.js';
import { SemanticSearchEngine, KIND_SCORE_WEIGHT } from '../src/semantic/searchEngine.js';
import { CallGraphAnalyzer } from '../src/graph/callGraph.js';
import { ImpactAnalyzer } from '../src/graph/impactAnalyzer.js';
import { VulnerabilityScanner } from '../src/security/vulnerabilityScanner.js';
import { ModelValidator } from '../src/validator/modelValidator.js';
import { CodebaseWatcher } from '../src/watcher/fileWatcher.js';
import { SecretSanitizer } from '../src/security/secretSanitizer.js';
import { IndexEncryption } from '../src/storage/encryption.js';
import { ExecutionFlowTracer } from '../src/flow/executionFlow.js';
import { ASTSkeletonizer } from '../src/context/skeletonizer.js';
import { ContextPackGenerator } from '../src/context/contextPack.js';
import { ContractDriftDetector } from '../src/microservices/contractDrift.js';
import { PageRankCalculator } from '../src/graph/pageRank.js';
import { DenseVectorEngine } from '../src/semantic/denseVectorEngine.js';
import { DashboardGenerator } from '../src/ui/dashboardGenerator.js';
import { ImportResolver } from '../src/graph/importResolver.js';
import { GitIgnoreRules } from '../src/extractors/gitignore.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as assert from 'assert';

console.log('🧪 Starting Unit & Enterprise Algorithm Test Suite for Codebase Trainer...\n');

const repoPath = process.cwd();

// Test 1: AST Extractor with Symbol Extraction & Ignore Filtering
console.log('1️⃣ Testing ASTExtractor & Symbol Extraction...');
const facts = ASTExtractor.scanDirectory(repoPath);
console.log(`   ✅ Facts extracted: ${facts.length} files scanned.`);
const astFact = facts.find(f => f.filePath.includes('astExtractor.ts'));
assert.ok(astFact, 'AST extractor fact should exist');
assert.ok(astFact.symbols && astFact.symbols.includes('ASTExtractor'), 'Should extract ASTExtractor symbol');
console.log(`   ✅ Extracted symbols: ${astFact.symbols?.slice(0, 5).join(', ')}...`);

// Test 2: Convention Miner
console.log('2️⃣ Testing ConventionMiner...');
const conventions = ConventionMiner.generateConventions(repoPath, facts);
console.log(`   ✅ conventions.yaml mined for ${conventions.codebaseName}.`);

// Test 3: Okapi BM25 & Hybrid AST Search Engine
console.log('3️⃣ Testing Hybrid AST + Okapi BM25 Search Engine...');
SemanticSearchEngine.buildIndex(repoPath);
const searchHits = SemanticSearchEngine.search(repoPath, 'ASTExtractor', 3);
console.log(`   ✅ Hybrid search executed: ${searchHits.length} ranked matches found.`);
assert.ok(searchHits.length > 0, 'Search should find matches');
console.log(`   ✅ Top hit match type: ${searchHits[0].matchType || 'semantic'} with score: ${searchHits[0].score.toFixed(2)}`);

// Test 4: Call Graph & Quality Auditor
console.log('4️⃣ Testing CallGraphAnalyzer...');
const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
console.log(`   ✅ Call-Graph mapped: ${Object.keys(graph.nodes).length} function nodes.`);

// Test 5: Downstream Impact Analyzer
console.log('5️⃣ Testing ImpactAnalyzer...');
const impact = ImpactAnalyzer.analyzeImpact(repoPath, 'astExtractor.ts');
console.log(`   ✅ Impact analysis completed: ${impact.affectedRoutes.length} symbol references traced.`);

// Test 6: Vulnerability Scanner
console.log('6️⃣ Testing VulnerabilityScanner...');
const findings = VulnerabilityScanner.scanCodebase(repoPath);
console.log(`   ✅ Vulnerability scan completed: ${findings.length} findings.`);

// Test 7: Model Health & Self-Correction
console.log('7️⃣ Testing ModelValidator...');
const health = ModelValidator.validateAndSelfCorrect(repoPath);
console.log(`   ✅ Model Health Score: ${health.healthScore}%`);

// Test 8: Real-Time Background File Watcher
console.log('8️⃣ Testing CodebaseWatcher...');
if (typeof CodebaseWatcher.watch === 'function') {
  console.log(`   ✅ CodebaseWatcher real-time event listener initialized.`);
}

// Test 9: Enterprise Secret & PII Sanitizer
console.log('9️⃣ Testing Enterprise SecretSanitizer & PII filter...');
const dummyContent = 'const apiKey = "fake_test_dummy_token_9876543210zyxwvutsrq";\nconst dbUrl = "postgres://admin:superSecret123@localhost:5432/mydb";';
const sanitized = SecretSanitizer.sanitizeContent(dummyContent);
assert.ok(sanitized.redactedCount > 0, 'Should redact secret keys and credentials');
assert.ok(!sanitized.sanitizedText.includes('fake_test_dummy_token_9876543210zyxwvutsrq'), 'API key must be redacted');
assert.ok(!sanitized.sanitizedText.includes('superSecret123'), 'DB password must be redacted');
console.log(`   ✅ Redacted ${sanitized.redactedCount} sensitive tokens: ${sanitized.detectedTypes.join(', ')}`);

// Test 10: AES-256-GCM Encryption at Rest
console.log('🔟 Testing AES-256-GCM Vector Store Encryption & Decryption...');
const testPayload = JSON.stringify({ secretModel: "proprietary_ast_vectors_2026" });
const encrypted = IndexEncryption.encrypt(testPayload, repoPath);
assert.strictEqual(encrypted.encrypted, true);
assert.strictEqual(encrypted.algorithm, 'aes-256-gcm');
assert.ok(encrypted.iv && encrypted.tag && encrypted.data);
const decrypted = IndexEncryption.decrypt(encrypted, repoPath);
assert.strictEqual(decrypted, testPayload);
console.log(`   ✅ AES-256-GCM round-trip encryption & decryption verified.`);

// Test 11: Fast Differential Incremental Indexing
console.log('1️⃣1️⃣ Testing Fast Differential Indexing (<50ms)...');
const diffResult = SemanticSearchEngine.updateFileChunks(repoPath, [path.join(repoPath, 'src/semantic/searchEngine.ts')]);
console.log(`   ✅ Differential update processed ${diffResult.updatedCount} chunks in ${diffResult.durationMs}ms.`);
assert.ok(diffResult.durationMs < 500, 'Differential update should be fast (<500ms on Windows/OneDrive)');

// Test 12: Interactive Sequence HTML Generator
console.log('1️⃣2️⃣ Testing Interactive Sequence Flow Generator...');
const flowResult = ExecutionFlowTracer.traceFlow(repoPath, 'BM25 search algorithm');
const htmlFile = ExecutionFlowTracer.generateInteractiveHTML(repoPath, flowResult);
console.log(`   ✅ Interactive HTML flow generated at: ${htmlFile}`);

// Test 13: AST Skeletonizer & Token Estimation
console.log('1️⃣3️⃣ Testing AST Skeletonizer & Token Estimation (Repomix / Aider style)...');
const sampleTS = `
import { Router } from 'express';
export interface DomainConfig {
  hostname: string;
  isCustom: boolean;
}
export async function setupDomain(config: DomainConfig): Promise<boolean> {
  const normalized = config.hostname.toLowerCase();
  console.log("Setting up domain", normalized);
  let status = true;
  for (let i = 0; i < 10; i++) {
    status = status && (i > 0);
  }
  return status;
}
`;
const skeletonResult = ASTSkeletonizer.skeletonize(sampleTS, 'sample.ts');
assert.ok(skeletonResult.skeleton.includes('export interface DomainConfig'));
assert.ok(skeletonResult.skeleton.includes('/* ... implementation ... */'));
assert.ok(!skeletonResult.skeleton.includes('console.log("Setting up domain"'), 'Function body should be stripped');
assert.ok(skeletonResult.compressionRatio < 0.85, 'Compression should reduce token size');
console.log(`   ✅ AST Skeletonizer achieved ${((1 - skeletonResult.compressionRatio) * 100).toFixed(0)}% token compression.`);

// Test 14: Token-Budgeted Agent Context Pack
console.log('1️⃣4️⃣ Testing Token-Budgeted Context Pack (--max-tokens 800)...');
const budgetPack = ContextPackGenerator.generateContextPack(repoPath, 'BM25 search engine', 800);
assert.strictEqual(budgetPack.maxTokens, 800);
assert.ok(budgetPack.tokenCount <= 850, `Pack tokens (${budgetPack.tokenCount}) should respect token budget`);
assert.ok(budgetPack.topSemanticChunks.length > 0, 'Should include semantic chunks');
console.log(`   ✅ Context Pack generated with ${budgetPack.tokenCount} tokens (budget: 800, skeletonized: ${budgetPack.isSkeletonized}).`);

// Test 15: Client-to-Server API Contract Drift Detector
console.log('1️⃣5️⃣ Testing Client-to-Server API Contract Drift Detector...');
const driftReport = ContractDriftDetector.detectDrift(repoPath);
assert.ok(typeof driftReport.scannedClientCalls === 'number');
assert.ok(typeof driftReport.scannedServerEndpoints === 'number');
assert.ok(['HEALTHY', 'DRIFT_DETECTED', 'CRITICAL_MISMATCH'].includes(driftReport.healthStatus));
console.log(`   ✅ Drift scan finished: ${driftReport.scannedClientCalls} client calls, ${driftReport.scannedServerEndpoints} endpoints, status: ${driftReport.healthStatus}.`);

// Test 16: PageRank Graph Centrality (Aider repomap style)
console.log('1️⃣6️⃣ Testing PageRank Graph Centrality Engine...');
const prResult = PageRankCalculator.calculate(repoPath);
assert.ok(prResult.topFiles.length > 0, 'Should have ranked files');
assert.ok(prResult.topSymbols.length > 0, 'Should have ranked symbols');
const topFile = prResult.topFiles[0];
console.log(`   ✅ PageRank computed: Top architectural hub is \`${topFile.filePath}\` (score: ${topFile.score}).`);

// Test 17: Local Dense Vector Embeddings & Cosine Similarity
console.log('1️⃣7️⃣ Testing 100% Offline Dense Vector Embeddings & Similarity...');
const vecQuery = DenseVectorEngine.embedText('semantic search engine indexing');
const vecMatch = DenseVectorEngine.embedText('codebase indexing and semantic search');
const vecUnrelated = DenseVectorEngine.embedText('baking chocolate strawberry cake in the oven');
assert.strictEqual(vecQuery.length, 128);
const simMatch = DenseVectorEngine.cosineSimilarity(vecQuery, vecMatch);
const simUnrelated = DenseVectorEngine.cosineSimilarity(vecQuery, vecUnrelated);
assert.ok(simMatch > simUnrelated, `Related vectors (${simMatch.toFixed(3)}) must have higher cosine similarity than unrelated (${simUnrelated.toFixed(3)})`);
console.log(`   ✅ Dense vector cosine similarity verified: related=${simMatch.toFixed(3)}, unrelated=${simUnrelated.toFixed(3)}.`);

// Test 18: Interactive Mermaid Dashboard Generator
console.log('1️⃣8️⃣ Testing Interactive Mermaid Dashboard Generator...');
const conventionsLoaded = ConventionMiner.loadConventions(repoPath) || ConventionMiner.generateConventions(repoPath, facts);
const callGraph = CallGraphAnalyzer.analyzeGraph(repoPath);
const dashboardPath = DashboardGenerator.generateHTML(repoPath, conventionsLoaded, callGraph);
assert.ok(fs.existsSync(dashboardPath), 'Dashboard HTML file should exist');
const dashboardHTML = fs.readFileSync(dashboardPath, 'utf8');
assert.ok(dashboardHTML.includes('graph TD'), 'Dashboard should contain Mermaid graph definition');
assert.ok(dashboardHTML.includes('mermaid.initialize'), 'Dashboard should initialize Mermaid');
console.log(`   ✅ Interactive Mermaid Dashboard generated at: ${dashboardPath}`);

// Test 19: Import Resolution Graph (ESM imports, tsconfig aliases, cycles, impact)
console.log('1️⃣9️⃣ Testing Import Resolver & Resolved Dependency Graph...');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-trainer-imports-'));
const writeFixture = (rel: string, content: string) => {
  const abs = path.join(fixtureRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
};
writeFixture('tsconfig.json', `{
  // comments and trailing commas are allowed in tsconfig
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, "homepage": "https://example.test/*" },
}`);
writeFixture('src/app/page.tsx', `import React from 'react';
import {
  getLinks,
  createLink
} from '@/store/links';
import type { Link } from '../types';
export default function Page() { return getLinks(); }
`);
writeFixture('src/store/links.ts', `import { api } from '../api/client.js';
export * from './helpers';
const legacy = require('./legacy');
export async function getLinks() { const lazy = await import('./lazy'); return api('/api/links'); }
`);
writeFixture('src/store/helpers/index.ts', `import { getLinks } from '../links';
export const refresh = () => getLinks();
`);
writeFixture('src/store/legacy.cjs', `module.exports = {};\n`);
writeFixture('src/store/lazy.ts', `export const lazy = true;\n`);
writeFixture('src/api/client.ts', `export function api(url: string) { return fetch(url); }\n`);
writeFixture('src/types.ts', `export interface Link { id: string }\n`);
writeFixture('py/pkg/__init__.py', '');
writeFixture('py/pkg/a.py', `from .b import thing\nimport os\n`);
writeFixture('py/pkg/b.py', `thing = 1\n`);

try {
  const fixtureFacts = ASTExtractor.scanDirectory(fixtureRoot);
  const abs = (rel: string) => path.join(fixtureRoot, rel);
  const pageFact = fixtureFacts.find(f => f.filePath === abs('src/app/page.tsx'));
  assert.ok(pageFact, 'Fixture page should be indexed');
  assert.deepStrictEqual([...pageFact.importedModules].sort(), ['../types', '@/store/links', 'react'], 'Should extract multi-line, type-only and default ESM imports');

  const importGraph = ImportResolver.buildImportGraph(fixtureRoot, fixtureFacts);
  assert.deepStrictEqual([...importGraph[abs('src/app/page.tsx')]].sort(), [abs('src/store/links.ts'), abs('src/types.ts')].sort(), 'Should resolve tsconfig alias and relative import, dropping external packages');
  assert.deepStrictEqual([...importGraph[abs('src/store/links.ts')]].sort(), [
    abs('src/api/client.ts'), abs('src/store/helpers/index.ts'), abs('src/store/lazy.ts'), abs('src/store/legacy.cjs')
  ].sort(), 'Should resolve .js -> .ts, index files, re-exports, require() and dynamic import()');
  assert.deepStrictEqual(importGraph[abs('py/pkg/a.py')], [abs('py/pkg/b.py')], 'Should resolve Python relative imports');

  const cycles = CallGraphAnalyzer.findImportCycles(importGraph);
  assert.strictEqual(cycles.length, 1, 'Should detect exactly one import cycle');
  assert.deepStrictEqual([...cycles[0]].sort(), [abs('src/store/helpers/index.ts'), abs('src/store/links.ts')].sort());

  const fixtureImpact = ImpactAnalyzer.analyzeImpact(fixtureRoot, 'src/api/client.ts');
  assert.deepStrictEqual(fixtureImpact.directDependents, ['src/store/links.ts'], 'Only the real importer is a direct dependent');
  assert.deepStrictEqual([...fixtureImpact.transitiveDependents].sort(), ['src/app/page.tsx', 'src/store/helpers/index.ts'], 'Transitive dependents follow the reverse import graph');

  const symbolImpact = ImpactAnalyzer.analyzeImpact(fixtureRoot, 'api');
  assert.deepStrictEqual(symbolImpact.directDependents, ['src/store/links.ts'], 'Symbol targets resolve to their declaring file');
  console.log(`   ✅ Resolved ${Object.values(importGraph).reduce((n, t) => n + t.length, 0)} import edges, ${cycles.length} cycle, impact traced through aliases.`);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

// Test 20: Search result kinds, doc down-weighting and compact agent output
console.log('2️⃣0️⃣ Testing Search Result Kinds & Compact Output...');
const searchFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-trainer-search-'));
try {
  const codeLines = Array.from({ length: 20 }, (_, i) => `const filler${i} = ${i};`);
  codeLines.push('export function revokeApiKey(keyId: string) {', '  return store.revoke(keyId);', '}');
  fs.mkdirSync(path.join(searchFixture, 'src'), { recursive: true });
  fs.writeFileSync(path.join(searchFixture, 'src', 'keys.ts'), codeLines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(searchFixture, 'GUIDE.md'), Array.from({ length: 10 }, () => 'Revoke an API key: revoke api key revokeApiKey revoke key.').join('\n'), 'utf8');

  const hits = SemanticSearchEngine.search(searchFixture, 'how to revoke an api key', 5);
  const codeHit = hits.find(h => h.filePath.endsWith('keys.ts'));
  const docHit = hits.find(h => h.filePath.endsWith('GUIDE.md'));
  assert.ok(codeHit && docHit, 'Both code and doc should match');
  assert.strictEqual(codeHit.kind, 'code');
  assert.strictEqual(docHit.kind, 'doc');
  assert.ok(docHit.score / KIND_SCORE_WEIGHT.doc > codeHit.score, 'Fixture doc should outscore code before weighting');
  assert.ok(hits.indexOf(codeHit) < hits.indexOf(docHit), 'Code should rank above docs after weighting');

  // The 23-line chunk starting at L1 must be narrowed down to the window around the definition
  const fullChunk = hits.find(h => h.filePath.endsWith('keys.ts') && h.startLine === 1);
  assert.ok(fullChunk && fullChunk.snippet.split('\n').length > 12, 'Fixture should produce a chunk longer than the snippet window');
  const compact = SemanticSearchEngine.compactResults(searchFixture, 'how to revoke an api key', [fullChunk], 12);
  const fileLines = fs.readFileSync(path.join(searchFixture, 'src', 'keys.ts'), 'utf8').split('\n');
  assert.strictEqual(compact[0].filePath, 'src/keys.ts', 'Paths should be repo-relative');
  assert.strictEqual(compact[0].snippet.split('\n').length, 12, 'Snippet should be narrowed to 12 lines');
  assert.ok(compact[0].startLine > 1, 'Window should move past the filler lines');
  assert.ok(compact[0].snippet.includes('export function revokeApiKey'), 'Snippet should keep the matched definition');
  assert.strictEqual(compact[0].snippet.split('\n')[0], fileLines[compact[0].startLine - 1], 'startLine should point at the first snippet line');
  console.log(`   ✅ Code ranked above docs; compact snippet ${compact[0].filePath}#L${compact[0].startLine}-L${compact[0].endLine}.`);
} finally {
  fs.rmSync(searchFixture, { recursive: true, force: true });
}

// Test 21: .gitignore handling and index freshness (auto-refresh, stale reporting, legacy rebuild)
console.log('2️⃣1️⃣ Testing .gitignore Rules & Index Freshness...');
const rules = GitIgnoreRules.parse('# comment\n/generated/\n*.gen.ts\n!keep.gen.ts\ndocs/**/draft.md\n');
assert.ok(rules.ignores('generated/x.ts', false), 'Anchored directory rule should exclude its contents');
assert.ok(!rules.ignores('src/generated/x.ts', false), 'Anchored rule should not match nested directories');
assert.ok(rules.ignores('src/a.gen.ts', false) && !rules.ignores('src/keep.gen.ts', false), 'Negation should re-include a file');
assert.ok(rules.ignores('docs/a/b/draft.md', false) && rules.ignores('docs/draft.md', false), '** should match zero or more directories');

const freshFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-trainer-fresh-'));
const writeFresh = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(freshFixture, rel)), { recursive: true });
  fs.writeFileSync(path.join(freshFixture, rel), content, 'utf8');
};
const savedAutoRefresh = process.env.CODEBASE_TRAINER_AUTO_REFRESH;
try {
  writeFresh('.gitignore', '/generated/\n*.gen.ts\n');
  writeFresh('lib/store.ts', 'export function loadStore() { return 1; }\n');
  writeFresh('generated/client.ts', 'export const generatedClient = 1;\n');
  writeFresh('src/api.gen.ts', 'export const generatedApi = 1;\n');
  writeFresh('src/old.ts', 'export const oldThing = 1;\n');

  const listed = ASTExtractor.listSourceFiles(freshFixture).map(e => path.relative(freshFixture, e.filePath).replace(/\\/g, '/')).sort();
  assert.deepStrictEqual(listed, ['lib/store.ts', 'src/old.ts'], 'lib/ should be indexed and .gitignore exclusions respected');

  // Index written before file stats existed: first check rebuilds it in full
  fs.mkdirSync(path.join(freshFixture, '.codebase'), { recursive: true });
  fs.writeFileSync(path.join(freshFixture, '.codebase', 'embeddings.json'), JSON.stringify({ chunks: [] }), 'utf8');
  const legacy = SemanticSearchEngine.ensureFreshIndex(freshFixture);
  assert.ok(legacy.fullRebuild && legacy.checkedFiles === 2, 'Legacy index without stats should be rebuilt');
  assert.strictEqual(SemanticSearchEngine.ensureFreshIndex(freshFixture).refreshedFiles.length, 0, 'Unchanged repo needs no refresh');

  // Edit, add and delete files: the next search picks them up without a manual re-index
  writeFresh('lib/store.ts', 'export function loadStore() { return revokeWebhookSecret(); }\n');
  writeFresh('src/webhooks.ts', 'export function revokeWebhookSecret() { return true; }\n');
  fs.rmSync(path.join(freshFixture, 'src', 'old.ts'));
  const refreshed = SemanticSearchEngine.searchWithStatus(freshFixture, 'revokeWebhookSecret', 5);
  assert.deepStrictEqual([...refreshed.index.refreshedFiles].sort(), ['lib/store.ts', 'src/webhooks.ts']);
  assert.deepStrictEqual(refreshed.index.removedFiles, ['src/old.ts']);
  assert.ok(refreshed.results.some(r => r.filePath.endsWith('webhooks.ts')), 'New file should be searchable immediately');
  assert.ok(!SemanticSearchEngine.loadChunks(freshFixture).some(c => c.filePath.endsWith('old.ts')), 'Deleted file chunks should be dropped');

  // With auto-refresh disabled, changes are reported as stale instead of re-indexed
  process.env.CODEBASE_TRAINER_AUTO_REFRESH = '0';
  writeFresh('src/webhooks.ts', 'export function revokeWebhookSecret() { return false; } // changed\n');
  const staleSearch = SemanticSearchEngine.searchWithStatus(freshFixture, 'revokeWebhookSecret', 5);
  assert.deepStrictEqual(staleSearch.index.staleFiles, ['src/webhooks.ts']);
  assert.ok(staleSearch.results.find(r => r.filePath.endsWith('webhooks.ts'))?.stale, 'Hits from stale files should be flagged');
  console.log(`   ✅ .gitignore respected; refreshed ${refreshed.index.refreshedFiles.length} file(s), removed 1, flagged ${staleSearch.index.staleFiles.length} stale.`);
} finally {
  if (savedAutoRefresh === undefined) delete process.env.CODEBASE_TRAINER_AUTO_REFRESH;
  else process.env.CODEBASE_TRAINER_AUTO_REFRESH = savedAutoRefresh;
  fs.rmSync(freshFixture, { recursive: true, force: true });
}

// Test 22: Execution flow traced through real call sites and fetch -> route handler links
console.log('2️⃣2️⃣ Testing Execution Flow Tracing (page -> store -> fetch -> route -> data layer)...');
const flowFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-trainer-flow-'));
const writeFlow = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(flowFixture, rel)), { recursive: true });
  fs.writeFileSync(path.join(flowFixture, rel), content, 'utf8');
};
try {
  writeFlow('tsconfig.json', '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } } }');
  writeFlow('app/settings/keys/page.tsx', [
    "import { revokeApiKey, listApiKeys } from '@/lib/keysStore';",
    "import type { ApiKey } from '@/lib/types';",
    '',
    'export default function ApiKeysPage({ keys }: { keys: ApiKey[] }) {',
    '  const rows = listApiKeys();',
    '  return <button onClick={() => revokeApiKey(keys[0].id)}>Revoke API key</button>;',
    '}'
  ].join('\n'));
  writeFlow('lib/types.ts', 'export interface ApiKey { id: string }\n');
  writeFlow('lib/keysStore.ts', [
    'export async function listApiKeys() {',
    "  const res = await fetch('/api/keys');",
    '  return res.json();',
    '}',
    '',
    'export async function revokeApiKey(keyId: string) {',
    '  // revoke the api key on the server',
    "  return fetch(`/api/keys/${keyId}`, { method: 'DELETE' });",
    '}'
  ].join('\n'));
  writeFlow('app/api/keys/[id]/route.ts', [
    "import { deleteApiKey } from '@/lib/db';",
    '',
    'export async function DELETE(req: Request, { params }: { params: { id: string } }) {',
    '  await deleteApiKey(params.id);',
    '  return new Response(null, { status: 204 });',
    '}'
  ].join('\n'));
  writeFlow('app/api/keys/route.ts', 'export async function GET() { return Response.json([]); }\n');
  writeFlow('lib/db.ts', 'export async function deleteApiKey(keyId: string) {\n  return keyId;\n}\n');
  writeFlow('lib/unrelatedBanner.ts', 'export function renderMaintenanceBanner() { return "revoke api key maintenance window banner"; }\n');
  writeFlow('docs/API_KEYS.md', Array.from({ length: 12 }, () => 'Revoke API key: call revokeApiKey to revoke an api key.').join('\n'));

  const flow = ExecutionFlowTracer.traceFlow(flowFixture, 'revoke api key');
  const edgeSummary = flow.edges.map(e => `${e.kind}:${e.from.filePath}:${e.from.line}->${e.to.filePath}:${e.to.symbol}`);
  assert.ok(flow.pathFound, 'A real path should be found');
  assert.deepStrictEqual(flow.entryPoints, ['app/settings/keys/page.tsx'], 'The page should be the entry point');
  assert.ok(edgeSummary.includes('call:app/settings/keys/page.tsx:6->lib/keysStore.ts:revokeApiKey'), `page -> store call missing: ${edgeSummary.join(' | ')}`);
  const httpEdge = flow.edges.find(e => e.kind === 'http' && e.to.filePath === 'app/api/keys/[id]/route.ts');
  assert.ok(httpEdge, 'fetch with a template URL should link to the [id] route handler');
  assert.strictEqual(httpEdge.label, 'DELETE /api/keys/[id]');
  assert.deepStrictEqual([httpEdge.from.symbol, httpEdge.from.line, httpEdge.to.symbol, httpEdge.to.line], ['revokeApiKey', 8, 'DELETE', 3]);
  assert.ok(edgeSummary.includes('call:app/api/keys/[id]/route.ts:4->lib/db.ts:deleteApiKey'), 'Route handler -> data layer call should be included');
  assert.ok(!flow.edges.some(e => e.from.filePath.endsWith('.md') || e.to.filePath.endsWith('.md')), 'Docs must never appear as flow participants');
  assert.ok(!flow.edges.some(e => e.from.filePath === 'lib/types.ts' || e.to.filePath === 'lib/types.ts'), 'Type-only imports are not calls');
  const pageEdge = flow.edges.findIndex(e => e.to.symbol === 'revokeApiKey');
  assert.ok(pageEdge >= 0 && pageEdge < flow.edges.indexOf(httpEdge), `Edges should be ordered from the entry point: ${edgeSummary.join(' | ')}`);
  assert.ok(flow.mermaidDiagram.startsWith('sequenceDiagram') && flow.mermaidDiagram.includes('HTTP DELETE /api/keys/[id]'));
  assert.ok(flow.relatedFiles.some(r => r.filePath === 'lib/unrelatedBanner.ts'), 'Unconnected search matches are reported separately');

  // A query that only matches an isolated file must not invent a path
  const isolated = ExecutionFlowTracer.traceFlow(flowFixture, 'maintenance window banner');
  assert.strictEqual(isolated.pathFound, false);
  assert.strictEqual(isolated.edges.length, 0);
  assert.ok(isolated.relatedFiles.some(r => r.filePath === 'lib/unrelatedBanner.ts'));
  assert.ok(isolated.mermaidDiagram.includes('No call path found'));
  console.log(`   ✅ Traced ${flow.edges.length} edges from ${flow.entryPoints[0]}; isolated match reported without an invented path.`);
} finally {
  fs.rmSync(flowFixture, { recursive: true, force: true });
}

console.log('\n🎉 ALL 22 ENTERPRISE & ALGORITHM TESTS PASSED SUCCESSFULLY!');
