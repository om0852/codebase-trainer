import * as fs from 'fs';
import * as path from 'path';
import { ASTFact } from '../types/index.js';

interface PathAliasConfig {
  // Only set when the config declares `baseUrl`; bare specifiers are never resolved against the config dir otherwise
  baseUrl: string | null;
  pathsBase: string;
  paths: Record<string, string[]>;
}

const JS_TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
// Under NodeNext/ESM, TS sources import `./foo.js` while the file on disk is `./foo.ts`
const JS_TO_TS_EXTENSIONS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts']
};

/**
 * Resolves raw import specifiers (as extracted into ASTFact.importedModules) to files in the index.
 * Supports relative paths, ESM `.js` -> `.ts` mapping, index files, tsconfig/jsconfig `baseUrl` + `paths`
 * aliases, Python relative/absolute modules, and Java/Rust module paths. External packages resolve to null.
 */
export class ImportResolver {
  private readonly repoPath: string;
  // Normalized absolute path -> original ASTFact.filePath
  private readonly fileIndex = new Map<string, string>();
  private readonly aliasConfigCache = new Map<string, PathAliasConfig | null>();

  private constructor(repoPath: string, facts: ASTFact[]) {
    this.repoPath = path.resolve(repoPath);
    facts.forEach(f => this.fileIndex.set(ImportResolver.normalize(f.filePath), f.filePath));
    facts.filter(f => path.basename(f.filePath) === 'package.json' && !/[\\/]node_modules[\\/]/.test(f.filePath)).forEach(f => {
      try {
        const pkg = JSON.parse(fs.readFileSync(f.filePath, 'utf8'));
        if (typeof pkg.name === 'string') this.workspacePackages.set(pkg.name, { dir: path.dirname(f.filePath), manifest: pkg });
      } catch {
        // Unparseable manifest: imports of that package stay unresolved
      }
    });
  }

  // Monorepo workspace packages by name (`@acme/db` -> packages/db), from every package.json in the repo
  private readonly workspacePackages = new Map<string, { dir: string; manifest: { exports?: unknown; main?: string; module?: string } }>();

  /**
   * `@acme/db/schema` -> the file its package.json `exports["./schema"]` points to (any condition that resolves to
   * an indexed file, so `default: ./src/schema.ts` wins over `types: ./dist/schema.d.ts`), else `<pkg>/src/schema.*`.
   */
  private resolveWorkspacePackage(specifier: string): string | null {
    const name = [...this.workspacePackages.keys()]
      .filter(n => specifier === n || specifier.startsWith(n + '/'))
      .sort((a, b) => b.length - a.length)[0];
    if (!name) return null;
    const { dir, manifest } = this.workspacePackages.get(name)!;
    const subpath = specifier === name ? '.' : './' + specifier.slice(name.length + 1);

    const targets: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === 'string') targets.push(value);
      else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect);
    };
    const exportsField = manifest.exports;
    if (typeof exportsField === 'string' && subpath === '.') {
      targets.push(exportsField);
    } else if (exportsField && typeof exportsField === 'object') {
      const map = exportsField as Record<string, unknown>;
      if (map[subpath] !== undefined) {
        collect(map[subpath]);
      } else {
        // Wildcard subpaths: `"./*": "./src/*.ts"`
        Object.entries(map).forEach(([pattern, value]) => {
          const captured = ImportResolver.matchPathPattern(pattern, subpath);
          if (captured !== null && pattern.includes('*')) {
            const before = targets.length;
            collect(value);
            for (let i = before; i < targets.length; i++) targets[i] = targets[i].replace('*', captured);
          }
        });
      }
    }
    if (subpath === '.') [manifest.module, manifest.main].forEach(v => typeof v === 'string' && targets.push(v));

    for (const target of targets) {
      const resolved = this.matchJsTsCandidates(path.resolve(dir, target));
      if (resolved) return resolved;
    }
    // No (indexed) export target: try the conventional source layout
    const rest = subpath === '.' ? 'index' : subpath.slice(2);
    return this.matchJsTsCandidates(path.join(dir, 'src', rest)) ?? this.matchJsTsCandidates(path.join(dir, rest));
  }

  public static forFacts(repoPath: string, facts: ASTFact[]): ImportResolver {
    return new ImportResolver(repoPath, facts);
  }

  /**
   * Builds the resolved import graph: importing file -> imported files (both as ASTFact.filePath).
   */
  public static buildImportGraph(repoPath: string, facts: ASTFact[]): Record<string, string[]> {
    const resolver = new ImportResolver(repoPath, facts);
    const graph: Record<string, string[]> = {};
    facts.forEach(f => {
      const targets = new Set<string>();
      f.importedModules.forEach(spec => {
        const target = resolver.resolve(f.filePath, spec, f.language);
        if (target && target !== f.filePath) targets.add(target);
      });
      graph[f.filePath] = Array.from(targets);
    });
    return graph;
  }

  /**
   * Inverts an import graph: imported file -> files that import it.
   */
  public static invertGraph(graph: Record<string, string[]>): Record<string, string[]> {
    const inverted: Record<string, string[]> = {};
    Object.keys(graph).forEach(f => { inverted[f] = []; });
    Object.entries(graph).forEach(([from, targets]) => {
      targets.forEach(t => {
        (inverted[t] = inverted[t] || []).push(from);
      });
    });
    return inverted;
  }

  /**
   * Finds the indexed file a user-supplied path refers to (absolute, repo-relative, or a unique path suffix).
   */
  public findFile(target: string): string | null {
    const direct = this.fileIndex.get(ImportResolver.normalize(path.resolve(this.repoPath, target)));
    if (direct) return direct;

    const suffix = '/' + target.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
    const matches = Array.from(this.fileIndex.entries()).filter(([norm]) => norm.toLowerCase().endsWith(suffix));
    return matches.length === 1 ? matches[0][1] : null;
  }

  public resolve(fromFile: string, specifier: string, language?: string): string | null {
    const lang = language || this.languageOf(fromFile);
    if (lang === 'python') return this.resolvePython(fromFile, specifier);
    if (lang === 'java') return this.resolveBySegments(specifier.split('.'), ['.java']);
    if (lang === 'rust') return this.resolveRust(specifier);
    if (lang === 'typescript' || lang === 'javascript') return this.resolveJsTs(fromFile, specifier);
    return null;
  }

  private resolveJsTs(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = specifier.startsWith('/')
        ? path.join(this.repoPath, specifier)
        : path.resolve(path.dirname(fromFile), specifier);
      return this.matchJsTsCandidates(base);
    }

    // Monorepo workspace packages (`@acme/db/schema`)
    const workspace = this.resolveWorkspacePackage(specifier);
    if (workspace) return workspace;

    // tsconfig/jsconfig path aliases (e.g. `@/lib/store` -> `src/lib/store.ts`) and baseUrl imports
    const config = this.aliasConfigFor(fromFile);
    if (!config) return null;

    for (const [pattern, replacements] of Object.entries(config.paths)) {
      const captured = ImportResolver.matchPathPattern(pattern, specifier);
      if (captured === null) continue;
      for (const replacement of replacements) {
        const resolved = this.matchJsTsCandidates(path.resolve(config.pathsBase, replacement.replace('*', captured)));
        if (resolved) return resolved;
      }
    }

    return config.baseUrl ? this.matchJsTsCandidates(path.resolve(config.baseUrl, specifier)) : null;
  }

  private matchJsTsCandidates(base: string): string | null {
    const candidates: string[] = [base];
    const ext = path.extname(base);
    if (JS_TO_TS_EXTENSIONS[ext]) {
      const stem = base.slice(0, -ext.length);
      JS_TO_TS_EXTENSIONS[ext].forEach(e => candidates.push(stem + e));
    }
    JS_TS_EXTENSIONS.forEach(e => candidates.push(base + e));
    JS_TS_EXTENSIONS.forEach(e => candidates.push(path.join(base, 'index' + e)));
    return this.firstIndexed(candidates);
  }

  private resolvePython(fromFile: string, specifier: string): string | null {
    const leadingDots = specifier.match(/^\.*/)?.[0].length || 0;
    const segments = specifier.slice(leadingDots).split('.').filter(Boolean);

    const roots: string[] = [];
    if (leadingDots > 0) {
      let dir = path.dirname(fromFile);
      for (let i = 1; i < leadingDots; i++) dir = path.dirname(dir);
      roots.push(dir);
    } else {
      // Absolute module: try every ancestor of the importing file up to the repo root (handles src/ layouts)
      let dir = path.resolve(path.dirname(fromFile));
      while (this.isWithinRepo(dir)) {
        roots.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }

    for (const root of roots) {
      const base = path.join(root, ...segments);
      const resolved = this.firstIndexed([base + '.py', path.join(base, '__init__.py')]);
      if (resolved) return resolved;
    }
    return null;
  }

  private resolveRust(specifier: string): string | null {
    const segments = specifier.split('::').filter(s => s && !['crate', 'self', 'super'].includes(s));
    // `use crate::a::b::Item` may name an item inside a module, so retry with trailing segments dropped
    for (let len = segments.length; len > 0; len--) {
      const resolved = this.resolveBySegments(segments.slice(0, len), ['.rs'], ['mod.rs']);
      if (resolved) return resolved;
    }
    return null;
  }

  /**
   * Matches a module path such as `com.acme.UserService` against a unique indexed file path suffix.
   */
  private resolveBySegments(segments: string[], extensions: string[], indexNames: string[] = []): string | null {
    if (segments.length === 0) return null;
    const suffixes = extensions.map(e => '/' + segments.join('/') + e);
    indexNames.forEach(n => suffixes.push('/' + segments.join('/') + '/' + n));

    const lowered = suffixes.map(s => s.toLowerCase());
    const matches = Array.from(this.fileIndex.entries()).filter(([norm]) => lowered.some(s => norm.toLowerCase().endsWith(s)));
    return matches.length === 1 ? matches[0][1] : null;
  }

  private firstIndexed(candidates: string[]): string | null {
    for (const c of candidates) {
      const hit = this.fileIndex.get(ImportResolver.normalize(c));
      if (hit) return hit;
    }
    return null;
  }

  private languageOf(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'typescript';
    if (ext === '.py') return 'python';
    if (ext === '.java') return 'java';
    if (ext === '.rs') return 'rust';
    return 'unknown';
  }

  /**
   * Finds the nearest tsconfig.json / jsconfig.json between the importing file and the repo root.
   */
  private aliasConfigFor(fromFile: string): PathAliasConfig | null {
    let dir = path.resolve(path.dirname(fromFile));
    const visited: string[] = [];
    let config: PathAliasConfig | null = null;

    while (this.isWithinRepo(dir)) {
      if (this.aliasConfigCache.has(dir)) {
        config = this.aliasConfigCache.get(dir)!;
        break;
      }
      visited.push(dir);
      const configFile = ['tsconfig.json', 'jsconfig.json'].map(n => path.join(dir, n)).find(p => fs.existsSync(p));
      if (configFile) {
        config = ImportResolver.loadAliasConfig(configFile);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    visited.forEach(d => this.aliasConfigCache.set(d, config));
    return config;
  }

  private static loadAliasConfig(configFile: string, depth: number = 0): PathAliasConfig | null {
    let parsed: { extends?: unknown; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    try {
      parsed = JSON.parse(ImportResolver.stripJsonComments(fs.readFileSync(configFile, 'utf8')));
    } catch {
      return null;
    }

    const configDir = path.dirname(configFile);
    // Asserted rather than annotated so TypeScript does not narrow it to `null` across the loop below
    let inherited = null as PathAliasConfig | null;
    // `extends` is a string or (TypeScript 5+) an array where later entries override earlier ones. Only relative
    // entries are followed; package-based shared configs (`@acme/tsconfig/base.json`) rarely define project paths.
    const parents = (Array.isArray(parsed.extends) ? parsed.extends : [parsed.extends])
      .filter((e): e is string => typeof e === 'string' && e.startsWith('.'));
    for (const parent of depth < 5 ? parents : []) {
      const parentFile = parent.endsWith('.json') ? parent : parent + '.json';
      const loaded = this.loadAliasConfig(path.resolve(configDir, parentFile), depth + 1);
      if (!loaded) continue;
      const previous: PathAliasConfig | null = inherited;
      inherited = {
        baseUrl: loaded.baseUrl ?? previous?.baseUrl ?? null,
        pathsBase: Object.keys(loaded.paths).length > 0 ? loaded.pathsBase : (previous?.pathsBase ?? loaded.pathsBase),
        paths: Object.keys(loaded.paths).length > 0 ? loaded.paths : (previous?.paths ?? {})
      };
    }

    const options = parsed.compilerOptions || {};
    const baseUrl = options.baseUrl !== undefined ? path.resolve(configDir, options.baseUrl) : (inherited?.baseUrl ?? null);
    // `paths` resolve against baseUrl when set, otherwise against the config file that declares them
    const pathsBase = options.paths ? (baseUrl ?? configDir) : (inherited?.pathsBase ?? baseUrl ?? configDir);
    return { baseUrl, pathsBase, paths: options.paths || inherited?.paths || {} };
  }

  private static matchPathPattern(pattern: string, specifier: string): string | null {
    const star = pattern.indexOf('*');
    if (star === -1) return pattern === specifier ? '' : null;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) {
      return null;
    }
    return specifier.slice(prefix.length, specifier.length - suffix.length);
  }

  /**
   * Removes // and /* *\/ comments and trailing commas from tsconfig-style JSON without touching string contents.
   */
  private static stripJsonComments(text: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        out += ch;
        if (ch === '\\') { out += text[++i] ?? ''; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; out += ch; continue; }
      if (ch === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        out += '\n';
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++;
        continue;
      }
      out += ch;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
  }

  private isWithinRepo(dir: string): boolean {
    return ImportResolver.normalize(dir).startsWith(ImportResolver.normalize(this.repoPath));
  }

  private static normalize(p: string): string {
    const abs = path.resolve(p).replace(/\\/g, '/');
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }
}
