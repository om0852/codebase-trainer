import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LEGACY_TOOLS, TOOLS, callTool } from '../src/mcp/tools.js';
import { fitToBudget } from '../src/mcp/budget.js';
import { ProjectConfigLoader } from '../src/config/projectConfig.js';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { NeuralEmbeddings } from '../src/semantic/neuralEmbeddings.js';
import { PermissionMapBuilder } from '../src/security/permissionMap.js';
import { SetupWizard } from '../src/cli/setup.js';
import { withFixture } from './helpers.js';

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

const app: Record<string, string> = {
  'src/keys.ts': 'export function revokeApiKey(keyId: string) {\n  return keyId;\n}\n',
  'src/debt.ts': Array.from({ length: 60 }, (_, i) => `// TODO: clean up item number ${i} in the legacy key rotation path`).join('\n') + '\nexport const x = 1;\n'
};

test('eight tools, and every 1.x name maps onto one of them', () => {
  const names = TOOLS.map(t => t.name);
  assert.deepEqual(names, ['search', 'feature_slice', 'trace_flow', 'impact', 'review_diff', 'api_map', 'codebase_overview', 'quality_scan']);
  Object.entries(LEGACY_TOOLS).forEach(([legacy, map]) => {
    const { tool } = map({});
    assert.ok(names.includes(tool) || tool === 'get_context_pack', `${legacy} -> ${tool}`);
  });
  TOOLS.filter(t => t.name !== 'feature_slice').forEach(t => assert.ok('budget_tokens' in t.inputSchema.properties, `${t.name} takes budget_tokens`));
});

test('search: new and legacy names, refs detail, budget report', async () => {
  await withFixture(app, async root => {
    const result = parse(await callTool(root, 'search', { query: 'revoke api key' }));
    assert.match(result.semanticResults[0].filePath, /keys\.ts$/);
    assert.ok(result.semanticResults[0].snippet);
    assert.equal(result.mode, 'lexical');
    assert.ok(result.budget.tokens > 0 && result.budget.tokens <= result.budget.budgetTokens);

    const refs = parse(await callTool(root, 'search', { query: 'revoke api key', detail: 'refs' }));
    assert.equal(refs.semanticResults[0].snippet, undefined);

    const legacy = parse(await callTool(root, 'search_codebase', { query: 'revoke api key' }));
    assert.equal(legacy.semanticResults[0].filePath, result.semanticResults[0].filePath);
  });
});

test('budget_tokens cuts long lists and says what it cut', async () => {
  await withFixture(app, async root => {
    const full = parse(await callTool(root, 'quality_scan', { checks: ['debt'] }));
    const cut = parse(await callTool(root, 'quality_scan', { checks: ['debt'], budget_tokens: 300 }));
    assert.ok(full.result.length >= 60);
    assert.ok(cut.result.length < full.result.length);
    assert.ok(cut.budget.tokens <= 300, `tokens ${cut.budget.tokens}`);
    assert.match(cut.budget.omitted[0], /kept \d+ of \d+/);
  });
});

test('fitToBudget keeps the head of ranked lists and leaves small results alone', () => {
  const small = fitToBudget({ a: [1, 2, 3] }, 100);
  assert.deepEqual(small.value, { a: [1, 2, 3] });
  assert.equal(small.budget.omitted, undefined);

  const big = fitToBudget({ hits: Array.from({ length: 100 }, (_, i) => ({ rank: i, text: 'x'.repeat(40) })), note: 'kept' }, 200);
  assert.equal(big.value.hits[0].rank, 0);
  assert.ok(big.value.hits.length < 100);
  assert.equal(big.value.note, 'kept');
  assert.ok(big.budget.tokens <= 200);
});

test('review_diff as SARIF, unknown tools as errors', async () => {
  await withFixture(app, async root => {
    // Assembled at runtime so no live-looking key literal is committed in this test file
    const fakeStripeKey = ['sk', 'live', '51HxQzKJ2eZvKYlo2C8d9fGhT4uV7wX0yZ'].join('_');
    const diff = `diff --git a/src/keys.ts b/src/keys.ts\n--- a/src/keys.ts\n+++ b/src/keys.ts\n@@ -1,1 +1,2 @@\n export function revokeApiKey(keyId: string) {\n+  const secret = "${fakeStripeKey}";\n`;
    const sarif = parse(await callTool(root, 'review_diff', { diff, format: 'sarif' }));
    assert.equal(sarif.version, '2.1.0');
    assert.ok(sarif.runs[0].results.some((r: { ruleId: string }) => r.ruleId === 'hardcoded-secret'));

    const unknown = await callTool(root, 'no_such_tool', {});
    assert.equal(unknown.isError, true);
  });
});

test('codebase-trainer.yaml: excludes, shared embeddings switch, custom auth guards, bad settings warned', async () => {
  await withFixture({
    ...app,
    'generated/client.ts': 'export const generated = true;\n',
    'src/routes.ts': [
      "router.get('/teams', requireAuth, async (req, res) => res.json([]));",
      "router.post('/teams', ensureTeamMember, async (req, res) => res.json({}));",
      "router.post('/status', async (req, res) => res.json({}));"
    ].join('\n'),
    'codebase-trainer.yaml': [
      'exclude: ["generated/**"]',
      'embeddings: false',
      'auth:',
      '  guards: [ensureTeamMember]',
      'budgets:',
      '  defaultTokens: -5',
      'colour: blue'
    ].join('\n')
  }, root => {
    const files = ASTExtractor.listSourceFiles(root).map(f => path.relative(root, f.filePath).replace(/\\/g, '/'));
    assert.ok(!files.includes('generated/client.ts'));
    assert.ok(files.includes('src/keys.ts'));

    NeuralEmbeddings.enable(root, 'some-model');
    assert.equal(NeuralEmbeddings.config(root), null, 'the shared file turns embeddings off');

    const map = PermissionMapBuilder.build(root);
    assert.equal(map.routes.find(r => r.method === 'POST' && r.endpoint === '/teams')?.auth, 'required');

    const config = ProjectConfigLoader.load(root);
    assert.equal(config.budgets.defaultTokens, undefined);
    assert.ok(config.warnings.some(w => w.includes('budgets.defaultTokens')));
    assert.ok(config.warnings.some(w => w.includes('colour')));
  });
});

test('globs', () => {
  const g = (glob: string, file: string) => ProjectConfigLoader.globToRegExp(glob).test(file);
  assert.ok(g('generated/**', 'generated/a/b.ts'));
  assert.ok(!g('generated/**', 'src/generated.ts'));
  assert.ok(g('*.snap', 'tests/__snapshots__/a.snap'));
  assert.ok(g('src/**/*.gen.ts', 'src/x.gen.ts'));
  assert.ok(g('src/**/*.gen.ts', 'src/a/b/x.gen.ts'));
  assert.ok(!g('src/*.ts', 'src/a/x.ts'));
});

test('setup merges into existing client configs and never overwrites what it cannot read', async () => {
  await withFixture({
    '.mcp.json': JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }),
    '.cursor/mcp.json': '{ not json'
  }, root => {
    const dry = SetupWizard.configure(root, ['claude', 'vscode'], true);
    assert.deepEqual(dry.map(a => a.status), ['would-write', 'would-write']);
    assert.ok(!fs.existsSync(path.join(root, '.vscode', 'mcp.json')));

    const actions = SetupWizard.configure(root, ['claude', 'cursor', 'vscode']);
    assert.deepEqual(actions.map(a => `${a.client}:${a.status}`), ['claude:updated', 'cursor:skipped', 'vscode:written']);
    const claude = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(claude.mcpServers).sort(), ['codebase-trainer', 'other']);
    assert.equal(fs.readFileSync(path.join(root, '.cursor', 'mcp.json'), 'utf8'), '{ not json');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'mcp.json'), 'utf8')).servers['codebase-trainer'].type, 'stdio');

    assert.deepEqual(SetupWizard.configure(root, ['claude']).map(a => a.status), ['unchanged']);
    assert.throws(() => SetupWizard.clientsFor(root, ['emacs']), /Unknown client/);
    assert.ok(!SetupWizard.clientsFor(root, ['all']).includes('windsurf'), 'per-user configs only when named');
  });
});
