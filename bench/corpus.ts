import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

export interface CorpusRepo {
  name: string;
  repo: string;
  sha: string;
  stack: string;
}

export const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(BENCH_DIR, '.cache');

export function loadCorpus(): CorpusRepo[] {
  return JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'corpus.json'), 'utf8'));
}

export function repoDir(repo: CorpusRepo): string {
  return path.join(CACHE_DIR, repo.name);
}

/**
 * Clones a corpus repo at its pinned commit (shallow), or leaves it alone when already at that commit.
 */
export function ensureRepo(repo: CorpusRepo): string {
  const dir = repoDir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();

  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      if (git('rev-parse', 'HEAD') === repo.sha) return dir;
    } catch {
      // Broken checkout; re-fetch below
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
    git('init', '-q');
    git('remote', 'add', 'origin', `https://github.com/${repo.repo}.git`);
  }
  git('fetch', '-q', '--depth', '1', 'origin', repo.sha);
  git('checkout', '-q', '--force', 'FETCH_HEAD');
  return dir;
}

// `tsx bench/corpus.ts` clones every corpus repo (used by CI before running the benchmark)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadCorpus().forEach(repo => {
    const dir = ensureRepo(repo);
    console.log(`${repo.name}: ${repo.sha.slice(0, 7)} -> ${path.relative(process.cwd(), dir)}`);
  });
}
