import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { ExecutionFlowTracer } from '../src/flow/executionFlow.js';
import { ContractDriftDetector } from '../src/microservices/contractDrift.js';
import { repoPath, withFixture, withRepoLock } from './helpers.js';

test('interactive sequence-flow HTML is generated for a repo query', async () => {
  await withRepoLock(() => {
    const flowResult = ExecutionFlowTracer.traceFlow(repoPath, 'BM25 search algorithm');
    const htmlFile = ExecutionFlowTracer.generateInteractiveHTML(repoPath, flowResult);
    assert.ok(fs.existsSync(htmlFile), 'Flow viewer HTML should be written');
  });
});

test('API contract drift report has counts and a known health status', async () => {
  await withRepoLock(() => {
    const driftReport = ContractDriftDetector.detectDrift(repoPath);
    assert.ok(typeof driftReport.scannedClientCalls === 'number');
    assert.ok(typeof driftReport.scannedServerEndpoints === 'number');
    assert.ok(['HEALTHY', 'DRIFT_DETECTED', 'CRITICAL_MISMATCH'].includes(driftReport.healthStatus));
  });
});

const flowFixture: Record<string, string> = {
  'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } } }',
  'app/settings/keys/page.tsx': [
    "import { revokeApiKey, listApiKeys } from '@/lib/keysStore';",
    "import type { ApiKey } from '@/lib/types';",
    '',
    'export default function ApiKeysPage({ keys }: { keys: ApiKey[] }) {',
    '  const rows = listApiKeys();',
    '  return <button onClick={() => revokeApiKey(keys[0].id)}>Revoke API key</button>;',
    '}'
  ].join('\n'),
  'lib/types.ts': 'export interface ApiKey { id: string }\n',
  'lib/keysStore.ts': [
    'export async function listApiKeys() {',
    "  const res = await fetch('/api/keys');",
    '  return res.json();',
    '}',
    '',
    'export async function revokeApiKey(keyId: string) {',
    '  // revoke the api key on the server',
    "  return fetch(`/api/keys/${keyId}`, { method: 'DELETE' });",
    '}'
  ].join('\n'),
  'app/api/keys/[id]/route.ts': [
    "import { deleteApiKey } from '@/lib/db';",
    '',
    'export async function DELETE(req: Request, { params }: { params: { id: string } }) {',
    '  await deleteApiKey(params.id);',
    '  return new Response(null, { status: 204 });',
    '}'
  ].join('\n'),
  'app/api/keys/route.ts': 'export async function GET() { return Response.json([]); }\n',
  'lib/db.ts': 'export async function deleteApiKey(keyId: string) {\n  return keyId;\n}\n',
  'lib/unrelatedBanner.ts': 'export function renderMaintenanceBanner() { return "revoke api key maintenance window banner"; }\n',
  'docs/API_KEYS.md': Array.from({ length: 12 }, () => 'Revoke API key: call revokeApiKey to revoke an api key.').join('\n')
};

test('flow is traced page -> store -> fetch -> route handler -> data layer', async () => {
  await withFixture(flowFixture, root => {
    const flow = ExecutionFlowTracer.traceFlow(root, 'revoke api key');
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
  }, 'cb-trainer-flow-');
});

test('a query matching only an isolated file does not invent a path', async () => {
  await withFixture(flowFixture, root => {
    const isolated = ExecutionFlowTracer.traceFlow(root, 'maintenance window banner');
    assert.strictEqual(isolated.pathFound, false);
    assert.strictEqual(isolated.edges.length, 0);
    assert.ok(isolated.relatedFiles.some(r => r.filePath === 'lib/unrelatedBanner.ts'));
    assert.ok(isolated.mermaidDiagram.includes('No call path found'));
  }, 'cb-trainer-flow-');
});
