import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { ConventionMiner } from '../src/miner/conventionMiner.js';
import { DiffParser } from '../src/review/diffParser.js';
import { DiffChecker } from '../src/review/diffChecker.js';
import { repoPath, withFixture, withRepoLock, writeFile } from './helpers.js';

test('DiffParser handles modified, added and deleted files and `--` content lines', () => {
  const parsedDiff = DiffParser.parse([
    'diff --git a/db/schema.sql b/db/schema.sql',
    'index 111..222 100644',
    '--- a/db/schema.sql',
    '+++ b/db/schema.sql',
    '@@ -1,3 +1,3 @@',
    ' CREATE TABLE keys (',
    '--- old comment that looks like a file header',
    '+-- new comment',
    ' );',
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+export const a = 1;',
    '+export const b = 2;',
    '\\ No newline at end of file',
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const gone = 1;'
  ].join('\n'));
  assert.deepStrictEqual(parsedDiff.map(f => `${f.status}:${f.filePath}`), ['modified:db/schema.sql', 'added:src/new.ts', 'deleted:src/gone.ts']);
  assert.deepStrictEqual(parsedDiff[0].removedLines, [{ line: 2, text: '-- old comment that looks like a file header' }], 'A removed `-- ...` line inside a hunk is content, not a header');
  assert.deepStrictEqual(parsedDiff[0].addedLines, [{ line: 2, text: '-- new comment' }]);
  assert.deepStrictEqual(parsedDiff[1].addedLines.map(l => l.line), [1, 2]);
});

test('DiffChecker rejects prose instead of a diff', async () => {
  await withRepoLock(() => {
    const prose = DiffChecker.check(repoPath, { diff: 'Changed scopes so links:write needs edit rights; summary of the change.' });
    assert.strictEqual(prose.status, 'invalid-input');
    assert.strictEqual(prose.passed, false, 'Prose must never pass the diff check');
  });
});

test('DiffChecker reports file:line findings for a git working-tree change', async () => {
  await withFixture({
    'lib/keysStore.ts': [
      'export interface ApiKey { id: string }',
      '',
      'export async function revokeApiKey(keyId: string) {',
      "  return fetch(`/api/keys/${keyId}`, { method: 'DELETE' });",
      '}'
    ].join('\n') + '\n',
    'app/settings/page.tsx': [
      "import { revokeApiKey } from '../../lib/keysStore';",
      "import type { ApiKey } from '../../lib/keysStore';",
      'export default function Page({ k }: { k: ApiKey }) { return revokeApiKey(k.id); }'
    ].join('\n') + '\n',
    'app/api/keys/[id]/route.ts': [
      "import * as fs from 'fs';",
      'export async function DELETE(req: Request) {',
      '  return new Response(null);',
      '}'
    ].join('\n') + '\n',
    'lib/legacy.ts': 'export const legacyValue = 1;\n',
    'lib/usesLegacy.ts': "import { legacyValue } from './legacy';\nexport const doubled = legacyValue * 2;\n"
  }, root => {
    const git = (cmd: string) => execSync(`git -c user.email=test@example.com -c user.name=test -c core.autocrlf=false ${cmd}`, { cwd: root, stdio: 'pipe' });
    git('init -q');
    git('add -A');
    git('commit -q -m baseline');

    const conventions = ConventionMiner.generateConventions(root, ASTExtractor.scanDirectory(root));
    conventions.rules.structural.exportStyle = 'named';
    conventions.rules.structural.typeAnnotationRequirement = true;
    ConventionMiner.saveConventions(root, conventions);
    const cleanCheck = DiffChecker.check(root);
    assert.strictEqual(cleanCheck.status, 'no-changes', `Clean tree should have no changes: ${cleanCheck.source} ${cleanCheck.filesChecked.join(', ')}`);

    // Working-tree change: rename an export, drop an interface, add risky lines, delete a file, add an untracked file
    writeFile(root, 'lib/keysStore.ts', [
      'export async function revokeKey(keyId: string) {',
      '  const meta: any = { keyId };',
      "  console.log('revoking', meta);",
      "  return fetch(`/api/keys/${keyId}`, { method: 'PUT' });",
      '}'
    ].join('\n') + '\n');
    writeFile(root, 'app/api/keys/[id]/route.ts', [
      "import * as fs from 'fs';",
      'export async function DELETE(req: Request) {',
      "  const audit = fs.readFileSync('audit.log', 'utf8');",
      '  return new Response(audit);',
      '}'
    ].join('\n') + '\n');
    fs.rmSync(path.join(root, 'lib', 'legacy.ts'));
    // Assembled at runtime so no live-looking key literal is committed in this test file
    const fakeStripeKey = ['sk', 'live', 'Fx7Qm2Lp9Rt4Wz8Kc3Nv6Bd1Hy5Jg0'].join('_');
    writeFile(root, 'lib/config.ts', `export default function config() {\n  return { stripe: "${fakeStripeKey}" };\n}\n`);

    const report = DiffChecker.check(root);
    const got = report.findings.map(f => `${f.ruleId}@${f.filePath}:${f.line}`);
    const expectFinding = (key: string) => assert.ok(got.includes(key), `Missing ${key}; got ${got.join(' | ')}`);
    expectFinding('hardcoded-secret@lib/config.ts:2');
    expectFinding('removed-export-still-imported@app/settings/page.tsx:1');
    expectFinding('removed-export-still-imported@app/settings/page.tsx:2');
    expectFinding('removed-export-still-imported@lib/usesLegacy.ts:1');
    expectFinding('contract-drift@lib/keysStore.ts:4');
    expectFinding('no-explicit-any@lib/keysStore.ts:2');
    expectFinding('no-console-log@lib/keysStore.ts:3');
    expectFinding('sync-io-in-request-handler@app/api/keys/[id]/route.ts:3');
    expectFinding('export-style@lib/config.ts:1');
    assert.strictEqual(report.status, 'failed');
    assert.strictEqual(report.passed, false);
    assert.ok(report.filesChecked.includes('lib/config.ts'), 'Untracked files should be checked');
    assert.ok(report.source.includes('untracked'));
    assert.strictEqual(report.checksRun.length, DiffChecker.CHECKS.length);
    assert.ok(report.notCovered.some(n => n.startsWith('Authorization')), 'The report must say authorization logic is not checked');
    assert.ok(!report.findings.some(f => f.filePath === 'app/settings/page.tsx' && f.ruleId !== 'removed-export-still-imported'), 'Unchanged files only get import-breakage findings');
  }, 'cb-trainer-diff-');
});
