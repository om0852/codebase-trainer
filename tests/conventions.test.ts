import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { ConventionMiner } from '../src/miner/conventionMiner.js';
import { ModelValidator } from '../src/validator/modelValidator.js';
import { IntentClassifier } from '../src/classifier/intentClassifier.js';
import { repoPath, withFixture, withRepoLock } from './helpers.js';

test('ConventionMiner mines conventions for the repo', async () => {
  await withRepoLock(() => {
    const conventions = ConventionMiner.generateConventions(repoPath, ASTExtractor.scanDirectory(repoPath));
    assert.ok(conventions.codebaseName, 'Mined conventions should name the codebase');
  });
});

test('ModelValidator reports a model health score for the repo', async () => {
  await withRepoLock(() => {
    const health = ModelValidator.validateAndSelfCorrect(repoPath);
    assert.strictEqual(typeof health.healthScore, 'number');
  });
});

test('IntentClassifier assigns roles by path segment, not substring', () => {
  const roleOf = (rel: string) => IntentClassifier.classifyPath(rel).role;
  assert.strictEqual(roleOf('middleware.ts'), 'middleware');
  assert.strictEqual(roleOf('app/settings/page.tsx'), 'page');
  assert.strictEqual(roleOf('app/api/keys/route.ts'), 'controller_route');
  assert.strictEqual(roleOf('hooks/useApiKeys.ts'), 'hook');
  assert.strictEqual(roleOf('store/keysStore.ts'), 'store');
  assert.strictEqual(roleOf('components/KeyRow.tsx'), 'ui_component');
  assert.strictEqual(roleOf('src/validator/modelValidator.ts'), 'unknown', 'Substring "model" must not make a data model');
  assert.strictEqual(roleOf('src/microservices/routeRegistry.ts'), 'unknown', 'Substring "route" must not make a route handler');
  assert.strictEqual(roleOf('src/latest.ts'), 'unknown', 'Substring "test" must not make a test');
});

test('conventions are learned from code with evidence; legacy conventions are regenerated', async () => {
  await withFixture({
    'middleware.ts': 'export function middleware(req: Request) { return req; }\n',
    'app/settings/page.tsx': 'export default function SettingsPage() { return null; }\n',
    'app/api/keys/route.ts': 'export async function GET() { return Response.json([]); }\n',
    'hooks/useApiKeys.ts': 'export function useApiKeys() { return []; }\n',
    'store/keysStore.ts': 'const MAX_KEYS = 10;\nexport interface KeyRecord { id: string }\nexport async function revokeApiKey(keyId: string) { return keyId; }\n',
    'components/KeyRow.tsx': 'export default function KeyRow() { return null; }\n',
    'lib/format-date.ts': 'const DEFAULT_LOCALE = "en";\nexport function formatDate(value: Date) { return value.toISOString(); }\n',
    'lib/parse-query.ts': 'export type QueryParams = Record<string, string>;\nexport function parseQuery(input: string) { return input; }\n',
    'lib/build-url.ts': 'const BASE_PATH = "/api";\nexport function buildUrl(pathName: string) { return BASE_PATH + pathName; }\n',
    'lib/retry-request.ts': 'const RETRY_LIMIT = 3;\nexport class RetryPolicy {}\nexport const retryRequest = async (attempt: number) => attempt < RETRY_LIMIT;\n',
    'lib/api-client.ts': 'const REQUEST_TIMEOUT_MS = 5000;\nexport class ApiClient {}\nexport function sendRequest(url: string) { return url; }\n/** Shared error type */\nexport class ApiError extends Error {}\n',
    '.github/pull_request_template.md': '## What changed\n\n## How to test\n'
  }, root => {
    const learned = ConventionMiner.generateConventions(root, ASTExtractor.scanDirectory(root));
    const naming = learned.rules.structural.naming!;
    assert.strictEqual(naming.functions?.style, 'camelCase');
    assert.strictEqual(naming.types?.style, 'PascalCase');
    assert.strictEqual(naming.constants?.style, 'UPPER_SNAKE_CASE');
    assert.strictEqual(naming.files?.style, 'kebab-case', 'File naming should be learned from the files, not assumed');
    assert.ok(learned.rules.structural.namingConvention.includes('functions camelCase'));
    assert.strictEqual(learned.rules.structural.exportStyle, 'named', 'Framework default exports must not count against named exports');
    assert.ok(learned.evidence?.['structural.exportStyle'].includes('1 default-only'), learned.evidence?.['structural.exportStyle']);
    assert.deepStrictEqual(learned.rules.git.prTemplateSections, ['What changed', 'How to test'], 'PR sections come from the template, not a hard-coded list');
    assert.ok(learned.rules.customRules.every(r => r.source === 'default'), 'Shipped rules must be labelled as defaults');
    const roles = learned.architecture!.roles;
    assert.ok(roles.middleware?.examples.includes('middleware.ts') && roles.page?.count === 1 && roles.hook?.count === 1 && roles.store?.count === 1);
    assert.ok(!('architecturalMap' in learned), 'The per-file role map is replaced by role counts');

    // Old-format conventions (no evidence) are regenerated instead of served as-is
    ConventionMiner.saveConventions(root, { ...learned, evidence: undefined, rules: { ...learned.rules, structural: { ...learned.rules.structural, namingConvention: 'camelCase variables, PascalCase classes/interfaces' } } });
    const reloaded = ConventionMiner.loadOrGenerate(root);
    assert.ok(reloaded.evidence && reloaded.rules.structural.namingConvention.includes('kebab-case'), 'Legacy conventions should be regenerated');
    assert.strictEqual(ModelValidator.validateAndSelfCorrect(root).isSelfCorrected, false, 'Validator and miner must agree on export style');
  }, 'cb-trainer-conv-');
});
