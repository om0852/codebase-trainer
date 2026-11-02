import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TreeSitter } from '../src/parsing/treeSitter.js';

// Every test file imports this module, so the whole suite runs with tree-sitter parsing (as the CLI does).
// Set CODEBASE_TRAINER_PARSER=regex to run it against the regex fallback instead.
await TreeSitter.init();

/** The repository under test (the suite is run from the repo root). */
export const repoPath = process.cwd();

/** Writes `content` to `rel` (relative to `root`), creating parent directories. */
export function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

/** Path of `abs` relative to `root`, with forward slashes on every platform. */
export function relPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * Creates a temporary directory, writes `files` into it (keys are relative paths),
 * runs `fn` with the directory path and always removes the directory afterwards.
 */
export async function withFixture<T>(
  files: Record<string, string>,
  fn: (root: string) => T | Promise<T>,
  prefix = 'cb-trainer-'
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const LOCK_STALE_MS = 5 * 60 * 1000;
const lockDir = path.join(
  os.tmpdir(),
  `cb-trainer-test-${crypto.createHash('sha1').update(repoPath).digest('hex').slice(0, 12)}.lock`
);

/**
 * Runs `fn` while holding a cross-process lock on the repository under test.
 *
 * `node --test` runs test files in parallel processes, and the tests that index
 * the repo itself all read and write the same `.codebase/` files (embeddings,
 * conventions, encryption key). The lock serialises those tests across files.
 */
export async function withRepoLock<T>(fn: () => T | Promise<T>): Promise<T> {
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock released between mkdir and stat: retry immediately.
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
