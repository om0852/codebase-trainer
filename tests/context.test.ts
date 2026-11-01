import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASTSkeletonizer } from '../src/context/skeletonizer.js';
import { ContextPackGenerator } from '../src/context/contextPack.js';
import { repoPath, withRepoLock } from './helpers.js';

test('ASTSkeletonizer keeps signatures, strips bodies and compresses tokens', () => {
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
});

test('context pack respects an 800-token budget and includes semantic chunks', async () => {
  await withRepoLock(() => {
    const budgetPack = ContextPackGenerator.generateContextPack(repoPath, 'BM25 search engine', 800);
    assert.strictEqual(budgetPack.maxTokens, 800);
    assert.ok(budgetPack.tokenCount <= 850, `Pack tokens (${budgetPack.tokenCount}) should respect token budget`);
    assert.ok(budgetPack.topSemanticChunks.length > 0, 'Should include semantic chunks');
  });
});
