import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { GitIgnoreRules } from '../src/extractors/gitignore.js';
import { CodebaseWatcher } from '../src/watcher/fileWatcher.js';
import { repoPath, relPosix, withFixture, withRepoLock } from './helpers.js';

test('ASTExtractor scans the repo and extracts class symbols', async () => {
  await withRepoLock(() => {
    const facts = ASTExtractor.scanDirectory(repoPath);
    assert.ok(facts.length > 0, 'Repo scan should produce facts');
    const astFact = facts.find(f => f.filePath.includes('astExtractor.ts'));
    assert.ok(astFact, 'AST extractor fact should exist');
    assert.ok(astFact.symbols && astFact.symbols.includes('ASTExtractor'), 'Should extract ASTExtractor symbol');
  });
});

test('CodebaseWatcher exposes a watch function', () => {
  assert.strictEqual(typeof CodebaseWatcher.watch, 'function');
});

test('GitIgnoreRules handles anchors, negation and ** globs', () => {
  const rules = GitIgnoreRules.parse('# comment\n/generated/\n*.gen.ts\n!keep.gen.ts\ndocs/**/draft.md\n');
  assert.ok(rules.ignores('generated/x.ts', false), 'Anchored directory rule should exclude its contents');
  assert.ok(!rules.ignores('src/generated/x.ts', false), 'Anchored rule should not match nested directories');
  assert.ok(rules.ignores('src/a.gen.ts', false) && !rules.ignores('src/keep.gen.ts', false), 'Negation should re-include a file');
  assert.ok(rules.ignores('docs/a/b/draft.md', false) && rules.ignores('docs/draft.md', false), '** should match zero or more directories');
});

test('listSourceFiles respects .gitignore and never indexes node_modules or .codebase', async () => {
  await withFixture({
    '.gitignore': '/generated/\n*.gen.ts\n',
    'lib/store.ts': 'export function loadStore() { return 1; }\n',
    'generated/client.ts': 'export const generatedClient = 1;\n',
    'src/api.gen.ts': 'export const generatedApi = 1;\n',
    'src/old.ts': 'export const oldThing = 1;\n'
  }, root => {
    const listed = ASTExtractor.listSourceFiles(root).map(e => relPosix(root, e.filePath)).sort();
    assert.deepStrictEqual(listed, ['lib/store.ts', 'src/old.ts'], 'lib/ should be indexed and .gitignore exclusions respected');
    // Native separators (backslashes on Windows) must still be recognised as ignored directories
    assert.ok(!ASTExtractor.isIndexablePath(root, path.join(root, 'node_modules', 'pkg', 'index.js')), 'node_modules files are never indexable');
    assert.ok(!ASTExtractor.isIndexablePath(root, path.join(root, '.codebase', 'tech_debt.json')), '.codebase files are never indexable');
  }, 'cb-trainer-fresh-');
});
