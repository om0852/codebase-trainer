import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_IGNORED_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '*.pem',
  '*.key',
  '*.pkcs12',
  '*.pfx',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'serviceAccountKey.json',
  'client_secret*.json',
  '*.p8'
];

/**
 * Files excluded from indexing: the repo-root .codebaseignore plus standard credential / secret files.
 */
export class CodebaseIgnore {
  // Keyed by repo path; mtimeMs is null when the repo has no .codebaseignore
  private static cache = new Map<string, { mtimeMs: number | null; patterns: string[] }>();

  /**
   * Loads user-defined ignore patterns from .codebaseignore if present,
   * plus standard enterprise credential ignore patterns.
   * Cached per repo and re-read only when .codebaseignore changes.
   */
  public static loadIgnorePatterns(repoPath: string): string[] {
    const ignoreFile = path.join(repoPath, '.codebaseignore');
    let mtimeMs: number | null = null;
    try {
      mtimeMs = fs.statSync(ignoreFile, { throwIfNoEntry: false })?.mtimeMs ?? null;
    } catch {
      // Unreadable: treat as absent
    }

    const cached = this.cache.get(repoPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.patterns;

    const patterns = [...DEFAULT_IGNORED_FILES];
    if (mtimeMs !== null) {
      try {
        const content = fs.readFileSync(ignoreFile, 'utf8');
        content
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))
          .forEach(p => patterns.push(p));
      } catch {
        // ignore read error
      }
    }
    this.cache.set(repoPath, { mtimeMs, patterns });
    return patterns;
  }

  /**
   * Tests if a file path matches any .codebaseignore or secret file patterns.
   */
  public static isIgnoredFile(filePath: string, repoPath: string): boolean {
    const rel = path.relative(repoPath, filePath).replace(/\\/g, '/');
    const baseName = path.basename(filePath);
    const patterns = this.loadIgnorePatterns(repoPath);

    return patterns.some(pattern => {
      if (pattern.startsWith('*.')) {
        const ext = pattern.slice(1);
        return baseName.endsWith(ext);
      }
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return baseName.startsWith(prefix);
      }
      return rel === pattern || baseName === pattern || rel.includes('/' + pattern);
    });
  }
}
