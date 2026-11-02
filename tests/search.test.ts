import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SemanticSearchEngine, KIND_SCORE_WEIGHT } from '../src/semantic/searchEngine.js';
import { DenseVectorEngine } from '../src/semantic/denseVectorEngine.js';
import { TextNormalizer } from '../src/semantic/textNormalizer.js';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { repoPath, relPosix, withFixture, withRepoLock, writeFile } from './helpers.js';

test('hybrid AST + BM25 search finds ASTExtractor in the repo', async () => {
  await withRepoLock(() => {
    SemanticSearchEngine.buildIndex(repoPath);
    const searchHits = SemanticSearchEngine.search(repoPath, 'ASTExtractor', 3);
    assert.ok(searchHits.length > 0, 'Search should find matches');
  });
});

test('differential index update of one file is fast', async () => {
  await withRepoLock(() => {
    SemanticSearchEngine.buildIndex(repoPath);
    const diffResult = SemanticSearchEngine.updateFileChunks(repoPath, [path.join(repoPath, 'src', 'semantic', 'searchEngine.ts')]);
    assert.ok(diffResult.durationMs < 500, 'Differential update should be fast (<500ms on Windows/OneDrive)');
  });
});

test('dense vectors: related text is more similar than unrelated text', () => {
  const vecQuery = DenseVectorEngine.embedText('semantic search engine indexing');
  const vecMatch = DenseVectorEngine.embedText('codebase indexing and semantic search');
  const vecUnrelated = DenseVectorEngine.embedText('baking chocolate strawberry cake in the oven');
  assert.strictEqual(vecQuery.length, 128);
  const simMatch = DenseVectorEngine.cosineSimilarity(vecQuery, vecMatch);
  const simUnrelated = DenseVectorEngine.cosineSimilarity(vecQuery, vecUnrelated);
  assert.ok(simMatch > simUnrelated, `Related vectors (${simMatch.toFixed(3)}) must have higher cosine similarity than unrelated (${simUnrelated.toFixed(3)})`);
});

test('search ranks code above docs and compacts snippets around the definition', async () => {
  // A short module whose only declaration is the answer; the doc mentions the words far more often
  const codeLines = ["import { store } from './store';", '', 'export function revokeApiKey(keyId: string) {', '  return store.revoke(keyId);', '}'];
  await withFixture({
    'src/keys.ts': codeLines.join('\n'),
    'GUIDE.md': Array.from({ length: 10 }, () => 'Revoke an API key: revoke api key revokeApiKey revoke key.').join('\n')
  }, root => {
    const hits = SemanticSearchEngine.search(root, 'how to revoke an api key', 5);
    const codeHit = hits.find(h => h.filePath.endsWith('keys.ts'));
    const docHit = hits.find(h => h.filePath.endsWith('GUIDE.md'));
    assert.ok(codeHit && docHit, 'Both code and doc should match');
    assert.strictEqual(codeHit.kind, 'code');
    assert.strictEqual(docHit.kind, 'doc');
    assert.ok(docHit.score / KIND_SCORE_WEIGHT.doc > codeHit.score, 'Fixture doc should outscore code before weighting');
    assert.ok(hits.indexOf(codeHit) < hits.indexOf(docHit), 'Code should rank above docs after weighting');

    // A long (23-line) result must be narrowed to the window around the definition. Built directly so the check
    // does not depend on how the chunker cut the file.
    const longLines = [...Array.from({ length: 20 }, (_, i) => `const filler${i} = ${i};`), ...codeLines.slice(2)];
    const longChunk = { ...codeHit, startLine: 1, endLine: longLines.length, snippet: longLines.join('\n'), matchedSymbol: undefined };
    const compact = SemanticSearchEngine.compactResults(root, 'how to revoke an api key', [longChunk], 12);
    assert.strictEqual(compact[0].filePath, 'src/keys.ts', 'Paths should be repo-relative');
    assert.strictEqual(compact[0].snippet.split('\n').length, 12, 'Snippet should be narrowed to 12 lines');
    assert.ok(compact[0].startLine > 1, 'Window should move past the filler lines');
    assert.ok(compact[0].snippet.includes('export function revokeApiKey'), 'Snippet should keep the matched definition');
    assert.strictEqual(compact[0].snippet.split('\n')[0], longLines[compact[0].startLine - 1], 'startLine should point at the first snippet line');
  }, 'cb-trainer-search-');
});

test('index freshness: legacy rebuild, auto-refresh of edits, stale reporting when disabled', async () => {
  const savedAutoRefresh = process.env.CODEBASE_TRAINER_AUTO_REFRESH;
  try {
    await withFixture({
      '.gitignore': '/generated/\n*.gen.ts\n',
      'lib/store.ts': 'export function loadStore() { return 1; }\n',
      'generated/client.ts': 'export const generatedClient = 1;\n',
      'src/api.gen.ts': 'export const generatedApi = 1;\n',
      'src/old.ts': 'export const oldThing = 1;\n',
      // Index written before file stats existed: first check rebuilds it in full
      '.codebase/embeddings.json': JSON.stringify({ chunks: [] })
    }, root => {
      const legacy = SemanticSearchEngine.ensureFreshIndex(root);
      assert.ok(legacy.fullRebuild && legacy.checkedFiles === 2, 'Legacy index without stats should be rebuilt');
      assert.strictEqual(SemanticSearchEngine.ensureFreshIndex(root).refreshedFiles.length, 0, 'Unchanged repo needs no refresh');

      // Edit, add and delete files: the next search picks them up without a manual re-index
      writeFile(root, 'lib/store.ts', 'export function loadStore() { return revokeWebhookSecret(); }\n');
      writeFile(root, 'src/webhooks.ts', 'export function revokeWebhookSecret() { return true; }\n');
      fs.rmSync(path.join(root, 'src', 'old.ts'));
      const refreshed = SemanticSearchEngine.searchWithStatus(root, 'revokeWebhookSecret', 5);
      assert.deepStrictEqual([...refreshed.index.refreshedFiles].sort(), ['lib/store.ts', 'src/webhooks.ts']);
      assert.deepStrictEqual(refreshed.index.removedFiles, ['src/old.ts']);
      assert.ok(refreshed.results.some(r => r.filePath.endsWith('webhooks.ts')), 'New file should be searchable immediately');
      assert.ok(!SemanticSearchEngine.loadChunks(root).some(c => c.filePath.endsWith('old.ts')), 'Deleted file chunks should be dropped');

      // With auto-refresh disabled, changes are reported as stale instead of re-indexed
      process.env.CODEBASE_TRAINER_AUTO_REFRESH = '0';
      writeFile(root, 'src/webhooks.ts', 'export function revokeWebhookSecret() { return false; } // changed\n');
      const staleSearch = SemanticSearchEngine.searchWithStatus(root, 'revokeWebhookSecret', 5);
      assert.deepStrictEqual(staleSearch.index.staleFiles, ['src/webhooks.ts']);
      assert.ok(staleSearch.results.find(r => r.filePath.endsWith('webhooks.ts'))?.stale, 'Hits from stale files should be flagged');
    }, 'cb-trainer-fresh-');
  } finally {
    if (savedAutoRefresh === undefined) delete process.env.CODEBASE_TRAINER_AUTO_REFRESH;
    else process.env.CODEBASE_TRAINER_AUTO_REFRESH = savedAutoRefresh;
  }
});

test('stemming groups word families and query stopwords are dropped', () => {
  const sameStem = (...words: string[]) => new Set(words.map(w => TextNormalizer.stem(w))).size === 1;
  assert.ok(sameStem('resolve', 'resolver', 'resolved', 'resolution'), 'resolve family');
  assert.ok(sameStem('duplicate', 'duplicated', 'duplication', 'duplicates'), 'duplicate family');
  assert.ok(sameStem('classify', 'classifier', 'classification'), 'classify family');
  assert.ok(sameStem('name', 'names', 'naming'), 'name family');
  assert.ok(sameStem('map', 'mapped', 'mapping'), 'doubled consonant family');
  assert.ok(!sameStem('class', 'call') && TextNormalizer.stem('status') === 'status' && TextNormalizer.stem('classes') === 'class');
  assert.deepStrictEqual(TextNormalizer.words('parseHTTPRequest api_key my-file'), ['parse', 'http', 'request', 'api', 'key', 'my', 'file']);
  assert.deepStrictEqual(TextNormalizer.tokenizeQuery('how does import resolution work'), ['import', 'resolv']);
  assert.ok(TextNormalizer.tokenizeQuery('how does it work').length > 0, 'An all-stopword query still searches something');
});

test('classifyKind only treats tests/ inside the repo as tests', () => {
  const reposUnderTests = path.join(os.tmpdir(), 'tests', 'my-repo');
  assert.strictEqual(SemanticSearchEngine.classifyKind(path.join(reposUnderTests, 'tests', 'cart.spec.ts'), reposUnderTests), 'test');
  assert.strictEqual(SemanticSearchEngine.classifyKind(path.join(reposUnderTests, 'src', 'cart.ts'), reposUnderTests), 'code', 'A repo cloned under a tests/ folder is not all tests');
});

test('stemmed search, nested checkouts excluded, old-tokenizer index rebuilt', async () => {
  await withFixture({
    'src/importResolver.ts': 'export class ImportResolver {\n  resolve(specifier: string) { return this.resolveRelative(specifier); }\n  resolveRelative(spec: string) { return spec; }\n}\n',
    'tsconfig.json': '{ "compilerOptions": { "moduleResolution": "NodeNext", "module": "NodeNext" } }\n',
    'src/howItWorks.ts': 'export const how = "how does it work";\nexport const does = "does work";\n',
    // A git worktree inside the repo, and a folder excluded only via .git/info/exclude
    '.claude/worktrees/copy/.git': 'gitdir: elsewhere\n',
    '.claude/worktrees/copy/src/importResolver.ts': 'export class ImportResolver { resolve() {} }\n',
    '.git/info/exclude': 'local-only/\n',
    'local-only/notes.ts': 'export const resolution = 1;\n'
  }, root => {
    const scope = ASTExtractor.listSourceFiles(root).map(e => relPosix(root, e.filePath)).sort();
    assert.deepStrictEqual(scope, ['src/howItWorks.ts', 'src/importResolver.ts', 'tsconfig.json'], 'Nested checkouts and .git/info/exclude paths are not indexed');

    const ranked = SemanticSearchEngine.search(root, 'how does import resolution work', 5).map(h => relPosix(root, h.filePath));
    assert.strictEqual(ranked[0], 'src/importResolver.ts', `Stemmed query should find the resolver first, got ${ranked.join(', ')}`);

    // An index written by the previous tokenizer is rebuilt rather than matched against stemmed queries
    const storePath = path.join(root, '.codebase', 'embeddings.json');
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    stored.meta.tokenizer = 1;
    fs.writeFileSync(storePath, JSON.stringify(stored), 'utf8');
    assert.strictEqual(SemanticSearchEngine.ensureFreshIndex(root).fullRebuild, true);
    assert.strictEqual(SemanticSearchEngine.ensureFreshIndex(root).fullRebuild, false);
  }, 'cb-trainer-stem-');
});
