import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ChunkStores } from '../src/storage/chunkStore.js';
import { SemanticSearchEngine } from '../src/semantic/searchEngine.js';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { RepoWatch, WATCH_WARMUP_MS } from '../src/watcher/repoWatch.js';
import { withFixture, writeFile } from './helpers.js';

const files = {
  'src/keys.ts': 'export function revokeApiKey(keyId: string) {\n  return keyId;\n}\n',
  'src/billing.ts': 'export function chargeCustomer(amountCents: number) {\n  return amountCents;\n}\n'
};
const rels = (root: string) => SemanticSearchEngine.loadChunks(root).map(c => path.relative(root, c.filePath).replace(/\\/g, '/')).sort();

test('SQLite store: built, searched, and updated per file', async () => {
  await withFixture(files, root => {
    SemanticSearchEngine.buildIndex(root);
    assert.equal(SemanticSearchEngine.indexStorage(root).kind, 'sqlite');
    assert.ok(fs.existsSync(path.join(root, '.codebase', 'index.sqlite')));
    assert.ok(!fs.existsSync(path.join(root, '.codebase', 'embeddings.json')));
    assert.deepEqual(rels(root), ['src/billing.ts', 'src/keys.ts']);
    assert.match(SemanticSearchEngine.search(root, 'revoke api key', 1)[0].filePath, /keys\.ts$/);

    // Edit one file, add one, delete one: only those rows change
    writeFile(root, 'src/keys.ts', 'export function rotateSigningKey(keyId: string) {\n  return keyId;\n}\n');
    writeFile(root, 'src/refunds.ts', 'export function refundCharge(id: string) {\n  return id;\n}\n');
    fs.rmSync(path.join(root, 'src', 'billing.ts'));
    const fresh = SemanticSearchEngine.ensureFreshIndex(root);
    assert.deepEqual([...fresh.refreshedFiles].sort(), ['src/keys.ts', 'src/refunds.ts']);
    assert.deepEqual(fresh.removedFiles, ['src/billing.ts']);
    assert.deepEqual(rels(root), ['src/keys.ts', 'src/refunds.ts']);
    assert.match(SemanticSearchEngine.search(root, 'rotateSigningKey', 1)[0].filePath, /keys\.ts$/);
  });
});

test("SQLite store: another process's writes are picked up, and the index survives a moved checkout", async () => {
  await withFixture(files, root => {
    SemanticSearchEngine.buildIndex(root);
    const before = SemanticSearchEngine.loadChunks(root).length;

    // Another process (here: the cache dropped, as in a separate CLI run) updates the database
    ChunkStores.closeAll();
    writeFile(root, 'src/extra.ts', 'export const extra = 1;\n');
    SemanticSearchEngine.updateFileChunks(root, [path.join(root, 'src', 'extra.ts')]);
    ChunkStores.closeAll();
    assert.equal(SemanticSearchEngine.loadChunks(root).length, before + 1);

    // Paths are stored relative to the repo
    const moved = `${root}-moved`;
    fs.cpSync(root, moved, { recursive: true });
    try {
      assert.ok(SemanticSearchEngine.loadChunks(moved).every(c => c.filePath.startsWith(moved)));
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });
});

test('encrypted indexes stay in the encrypted JSON store', async () => {
  await withFixture({ ...files, '.codebase/.master.key': 'a'.repeat(64) }, root => {
    SemanticSearchEngine.buildIndex(root);
    assert.equal(SemanticSearchEngine.indexStorage(root).kind, 'json');
    assert.ok(!fs.existsSync(path.join(root, '.codebase', 'index.sqlite')));
    const stored = JSON.parse(fs.readFileSync(path.join(root, '.codebase', 'embeddings.json'), 'utf8'));
    assert.equal(stored.encrypted, true);
    assert.match(SemanticSearchEngine.search(root, 'revoke api key', 1)[0].filePath, /keys\.ts$/);
  });
});

test('watched repo: the patched file listing follows additions, edits and deletions', { skip: process.platform === 'linux' && Number(process.versions.node.split('.')[0]) < 20 }, async () => {
  await withFixture({ ...files, 'src/nested/deep.ts': 'export const deep = 1;\n' }, async root => {
    const listed = () => ASTExtractor.listSourceFiles(root).map(e => path.relative(root, e.filePath).replace(/\\/g, '/')).sort();
    assert.ok(RepoWatch.start(root));
    try {
      assert.deepEqual(listed(), ['src/billing.ts', 'src/keys.ts', 'src/nested/deep.ts']);
      // Past the start-up window every check walks the repo; after it, changes are patched from watch events
      await sleep(WATCH_WARMUP_MS + 200);
      listed();
      writeFile(root, 'src/new.ts', 'export const added = 1;\n');
      writeFile(root, 'src/keys.ts', 'export const changed = 22;\n');
      fs.rmSync(path.join(root, 'src', 'nested'), { recursive: true });
      // Watch events arrive asynchronously (macOS batches them, up to a second or more)
      const settled = () => { const l = listed(); return l.includes('src/new.ts') && !l.includes('src/nested/deep.ts'); };
      for (let i = 0; i < 100 && !settled(); i++) await sleep(50);
      assert.deepEqual(listed(), ['src/billing.ts', 'src/keys.ts', 'src/new.ts']);
      const keys = ASTExtractor.listSourceFiles(root).find(e => e.filePath.endsWith('keys.ts'))!;
      assert.equal(keys.size, fs.statSync(path.join(root, 'src', 'keys.ts')).size, 'edited file has fresh stats');
    } finally {
      RepoWatch.stop(root);
    }
  });
});

test('scanDirectory returns the same array while nothing changes, a new one after an edit', async () => {
  await withFixture(files, root => {
    const first = ASTExtractor.scanDirectory(root);
    assert.equal(ASTExtractor.scanDirectory(root), first);
    writeFile(root, 'src/keys.ts', 'export function revokeApiKey(keyId: string, reason: string) {\n  return keyId + reason;\n}\n');
    const after = ASTExtractor.scanDirectory(root);
    assert.notEqual(after, first);
    assert.equal(after.find(f => f.filePath.endsWith('billing.ts')), first.find(f => f.filePath.endsWith('billing.ts')), 'unchanged files keep their facts');
  });
});
