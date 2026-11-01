import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretSanitizer } from '../src/security/secretSanitizer.js';
import { IndexEncryption } from '../src/storage/encryption.js';
import { VulnerabilityScanner } from '../src/security/vulnerabilityScanner.js';
import { repoPath, withRepoLock } from './helpers.js';

test('SecretSanitizer redacts API keys and database passwords', () => {
  const dummyContent = 'const apiKey = "fake_test_dummy_token_9876543210zyxwvutsrq";\nconst dbUrl = "postgres://admin:superSecret123@localhost:5432/mydb";';
  const sanitized = SecretSanitizer.sanitizeContent(dummyContent);
  assert.ok(sanitized.redactedCount > 0, 'Should redact secret keys and credentials');
  assert.ok(!sanitized.sanitizedText.includes('fake_test_dummy_token_9876543210zyxwvutsrq'), 'API key must be redacted');
  assert.ok(!sanitized.sanitizedText.includes('superSecret123'), 'DB password must be redacted');
});

test('IndexEncryption round-trips a payload with AES-256-GCM', async () => {
  await withRepoLock(() => {
    const testPayload = JSON.stringify({ secretModel: 'proprietary_ast_vectors_2026' });
    const encrypted = IndexEncryption.encrypt(testPayload, repoPath);
    assert.strictEqual(encrypted.encrypted, true);
    assert.strictEqual(encrypted.algorithm, 'aes-256-gcm');
    assert.ok(encrypted.iv && encrypted.tag && encrypted.data);
    const decrypted = IndexEncryption.decrypt(encrypted, repoPath);
    assert.strictEqual(decrypted, testPayload);
  });
});

test('VulnerabilityScanner scans the repo and returns a findings list', async () => {
  await withRepoLock(() => {
    const findings = VulnerabilityScanner.scanCodebase(repoPath);
    assert.ok(Array.isArray(findings), 'Scanner should return a list of findings');
  });
});
