import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Committable project settings, read from `codebase-trainer.yaml` at the repo root (or `.codebase/config.yaml`).
 * Generated state (indexes, vectors) stays in `.codebase/`, which is usually gitignored; this file is meant to be
 * shared by a team.
 *
 *   exclude: ["generated/**", "**\/*.snap"]     # globs, on top of .gitignore and .codebaseignore
 *   embeddings: { enabled: true, model: Xenova/all-MiniLM-L6-v2 }
 *   auth: { guards: [requireTeamMember], publicPaths: [/api/status] }
 *   budgets: { defaultTokens: 8000, featureSliceTokens: 6000 }
 */

export interface ProjectConfig {
  exclude: string[];
  embeddings?: { enabled: boolean; model?: string };
  auth: { guards: string[]; publicPaths: string[] };
  budgets: { defaultTokens?: number; featureSliceTokens?: number };
  // Where the settings came from, and anything in the file that was ignored
  source: string | null;
  warnings: string[];
}

export const CONFIG_FILES = ['codebase-trainer.yaml', 'codebase-trainer.yml', path.join('.codebase', 'config.yaml')];

const EMPTY: ProjectConfig = { exclude: [], auth: { guards: [], publicPaths: [] }, budgets: {}, source: null, warnings: [] };

export class ProjectConfigLoader {
  private static cache = new Map<string, { key: string; checkedAt: number; config: ProjectConfig; excludes: RegExp[] }>();
  // Indexing asks for every file; look at the disk again at most this often
  private static readonly RECHECK_MS = 1000;

  public static load(repoPath: string): ProjectConfig {
    return this.entry(repoPath).config;
  }

  /** Whether a repo-relative POSIX path matches one of the config's `exclude` globs. */
  public static isExcluded(repoPath: string, relPath: string): boolean {
    const { excludes } = this.entry(repoPath);
    return excludes.length > 0 && excludes.some(re => re.test(relPath));
  }

  /** Glob to regex: `**` any depth, `*` within a segment, `?` one character; a pattern without `/` matches any depth. */
  public static globToRegExp(glob: string): RegExp {
    const pattern = glob.replace(/^\.\//, '').replace(/\/$/, '/**');
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*' && pattern[i + 1] === '*') {
        re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += pattern[i + 2] === '/' ? 2 : 1;
      } else if (ch === '*') {
        re += '[^/]*';
      } else if (ch === '?') {
        re += '[^/]';
      } else {
        re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    return new RegExp(`^${pattern.includes('/') ? '' : '(?:.*/)?'}${re}$`);
  }

  private static entry(repoPath: string): { config: ProjectConfig; excludes: RegExp[] } {
    const recent = this.cache.get(repoPath);
    if (recent && Date.now() - recent.checkedAt < this.RECHECK_MS) return recent;
    const file = CONFIG_FILES.map(f => path.join(repoPath, f)).find(f => fs.existsSync(f)) ?? null;
    let key = 'none';
    if (file) {
      try {
        key = `${file}:${fs.statSync(file).mtimeMs}`;
      } catch {
        key = 'unreadable';
      }
    }
    if (recent && recent.key === key) {
      recent.checkedAt = Date.now();
      return recent;
    }

    const config = file ? this.parse(repoPath, file) : EMPTY;
    const entry = { key, checkedAt: Date.now(), config, excludes: config.exclude.map(g => this.globToRegExp(g)) };
    this.cache.set(repoPath, entry);
    return entry;
  }

  private static parse(repoPath: string, file: string): ProjectConfig {
    const source = path.relative(repoPath, file).replace(/\\/g, '/');
    const warnings: string[] = [];
    let raw: unknown;
    try {
      raw = yaml.load(fs.readFileSync(file, 'utf8')) ?? {};
    } catch (err) {
      return { ...EMPTY, source, warnings: [`${source} is not valid YAML (${(err as Error).message.split('\n')[0]}); using defaults.`] };
    }
    if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
      return { ...EMPTY, source, warnings: [`${source} must be a mapping of settings; using defaults.`] };
    }
    const doc = raw as Record<string, unknown>;
    const strings = (value: unknown, name: string): string[] => {
      if (value === undefined) return [];
      if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value as string[];
      warnings.push(`${name} must be a list of strings; ignored.`);
      return [];
    };
    const number = (value: unknown, name: string): number | undefined => {
      if (value === undefined) return undefined;
      if (typeof value === 'number' && value > 0) return value;
      warnings.push(`${name} must be a positive number; ignored.`);
      return undefined;
    };

    const known = new Set(['exclude', 'embeddings', 'auth', 'budgets']);
    Object.keys(doc).filter(k => !known.has(k)).forEach(k => warnings.push(`Unknown setting \`${k}\`; ignored.`));

    let embeddings: ProjectConfig['embeddings'];
    if (typeof doc.embeddings === 'boolean') embeddings = { enabled: doc.embeddings };
    else if (doc.embeddings && typeof doc.embeddings === 'object') {
      const e = doc.embeddings as Record<string, unknown>;
      embeddings = { enabled: e.enabled !== false, ...(typeof e.model === 'string' && { model: e.model }) };
    } else if (doc.embeddings !== undefined) warnings.push('embeddings must be true, false or { enabled, model }; ignored.');

    const auth = (doc.auth ?? {}) as Record<string, unknown>;
    const budgets = (doc.budgets ?? {}) as Record<string, unknown>;
    return {
      exclude: strings(doc.exclude, 'exclude'),
      embeddings,
      auth: { guards: strings(auth.guards, 'auth.guards'), publicPaths: strings(auth.publicPaths, 'auth.publicPaths') },
      budgets: {
        defaultTokens: number(budgets.defaultTokens, 'budgets.defaultTokens'),
        featureSliceTokens: number(budgets.featureSliceTokens, 'budgets.featureSliceTokens')
      },
      source,
      warnings
    };
  }
}
