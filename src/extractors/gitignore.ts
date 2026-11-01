import * as fs from 'fs';
import * as path from 'path';

interface IgnoreRule {
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

/**
 * Minimal .gitignore matcher for the repo-root .gitignore and .git/info/exclude: comments, `!` negation
 * (last match wins), trailing `/` (directories only), anchored patterns (containing `/`), and `*`, `**`, `?` globs.
 */
export class GitIgnoreRules {
  private constructor(private readonly rules: IgnoreRule[]) {}

  public static load(repoPath: string): GitIgnoreRules {
    // info/exclude first so the repo's .gitignore (read later) wins on conflicting rules, as in git
    const content = [path.join(repoPath, '.git', 'info', 'exclude'), path.join(repoPath, '.gitignore')]
      .map(file => {
        try {
          return fs.readFileSync(file, 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    return GitIgnoreRules.parse(content);
  }

  public static parse(content: string): GitIgnoreRules {
    const rules: IgnoreRule[] = [];
    content.split(/\r?\n/).forEach(raw => {
      let line = raw.replace(/(?<!\\)\s+$/, '');
      if (!line || line.startsWith('#')) return;

      const negated = line.startsWith('!');
      if (negated) line = line.slice(1);
      if (line.startsWith('\\')) line = line.slice(1);

      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      // A slash anywhere but the end anchors the pattern to the repo root
      const anchored = line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      if (!line) return;

      const body = GitIgnoreRules.globToRegex(line);
      const regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
      rules.push({ regex, negated, dirOnly });
    });
    return new GitIgnoreRules(rules);
  }

  /**
   * @param relPath repo-relative path (either separator)
   * @param isDir whether relPath itself is a directory; ancestors are always tested as directories
   */
  public ignores(relPath: string, isDir: boolean): boolean {
    if (this.rules.length === 0) return false;
    const segments = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
    // Git cannot re-include a file whose parent directory is excluded, so check ancestors first
    for (let i = 1; i < segments.length; i++) {
      if (this.matches(segments.slice(0, i).join('/'), true)) return true;
    }
    return this.matches(segments.join('/'), isDir);
  }

  private matches(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(relPath)) ignored = !rule.negated;
    }
    return ignored;
  }

  private static globToRegex(glob: string): string {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i];
      if (ch === '*') {
        if (glob[i + 1] === '*') {
          // `**/` matches zero or more directories; a trailing `/**` matches everything inside
          if (glob[i + 2] === '/') {
            out += '(?:.*/)?';
            i += 2;
          } else {
            out += '.*';
            i += 1;
          }
        } else {
          out += '[^/]*';
        }
      } else if (ch === '?') {
        out += '[^/]';
      } else {
        out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    return out;
  }
}
