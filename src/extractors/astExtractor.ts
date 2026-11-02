import * as fs from 'fs';
import * as path from 'path';
import { ASTFact } from '../types/index.js';
import { CodebaseIgnore } from './codebaseIgnore.js';
import { GitIgnoreRules } from './gitignore.js';
import { extractCodeFacts } from '../parsing/codeFacts.js';
import { RepoWatch } from '../watcher/repoWatch.js';

// Build output, dependency and cache directories that are never indexed, even without a .gitignore
const IGNORED_DIRS = [
  'node_modules', '.git', '.codebase', 'dist', 'build', '.next', 'vendor',
  'target', '.venv', 'venv', 'env', '.env', '__pycache__', 'coverage',
  '.pytest_cache', 'site-packages', '.cache', 'Lib'
];
const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.sql', '.prisma', '.php', '.md', '.markdown', '.json'
];
// Skip giant data files
const MAX_FILE_BYTES = 500 * 1024;

export interface SourceFileEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
}

// A full walk at least this often even while a watcher reports changes, so a missed event is stale for at most
// a minute (a walk costs ~60 ms on 10,000 files)
const FULL_WALK_MS = 60 * 1000;
// Changes to these files can change which files are indexed
const RULE_FILES = new Set(['.gitignore', '.codebaseignore', 'codebase-trainer.yaml', 'codebase-trainer.yml', '.git/info/exclude']);

interface StatKey { mtimeMs: number; size: number }

export class ASTExtractor {
  // Per-process caches, valid while a file's mtime and size are unchanged: a long-running server reads and
  // analyses each file once instead of on every tool call
  private static contentCache = new Map<string, StatKey & { content: string }>();
  private static factCache = new Map<string, StatKey & { fact: ASTFact | null }>();
  private static listingCache = new Map<string, { entries: SourceFileEntry[]; walkedAt: number }>();
  // The last scanDirectory result per repo: returned as the same array while no file changed, so analyses keyed
  // on it (import graph, call edges) are reused
  private static lastScan = new Map<string, ASTFact[]>();

  private static statOf(filePath: string): fs.Stats | null {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Reads a source file as UTF-8, or returns null when it is missing or unreadable.
   */
  public static readSourceFile(filePath: string): string | null {
    const stats = this.statOf(filePath);
    if (!stats || !stats.isFile()) {
      this.contentCache.delete(filePath);
      return null;
    }
    const cached = this.contentCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.content;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (stats.size <= MAX_FILE_BYTES) this.contentCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, content });
      return content;
    } catch {
      return null;
    }
  }

  public static extractFileFacts(filePath: string, known?: StatKey): ASTFact | null {
    const stats = known ?? this.statOf(filePath);
    if (!stats || stats.size > MAX_FILE_BYTES) return null;
    const cached = this.factCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.fact;
    const fact = this.computeFileFacts(filePath);
    this.factCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, fact });
    return fact;
  }

  private static computeFileFacts(filePath: string): ASTFact | null {
    const content = this.readSourceFile(filePath);
    if (content === null) return null;

    const lines = content.split(/\r?\n/);
    const ext = path.extname(filePath).toLowerCase();

    let language = 'unknown';
    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      language = ['.ts', '.tsx', '.mts', '.cts'].includes(ext) ? 'typescript' : 'javascript';
    } else if (ext === '.py') {
      language = 'python';
    } else if (ext === '.go') {
      language = 'go';
    } else if (ext === '.rs') {
      language = 'rust';
    } else if (ext === '.java') {
      language = 'java';
    } else if (['.c', '.cpp', '.cc', '.h', '.hpp'].includes(ext)) {
      language = 'cpp';
    } else if (ext === '.sql') {
      language = 'sql';
    } else if (ext === '.prisma') {
      language = 'prisma';
    } else if (ext === '.php') {
      language = 'php';
    } else if (['.md', '.markdown', '.json'].includes(ext)) {
      language = ext.replace('.', '');
    } else {
      return null;
    }

    // Analyze Constants Placement
    let constTopCount = 0;
    let constInlineCount = 0;
    let constRegex = /(const|let|var)\s+[A-Z0-9_]+\s*=/;
    if (language === 'python') constRegex = /^[A-Z0-9_]+\s*=/;
    if (language === 'go') constRegex = /(const|var)\s+[A-Z0-9_]+/;
    if (language === 'rust') constRegex = /(const|static)\s+[A-Z0-9_]+/;

    lines.forEach((line: string, idx: number) => {
      if (constRegex.test(line.trim())) {
        if (idx < 30) {
          constTopCount++;
        } else {
          constInlineCount++;
        }
      }
    });

    let constantsPlacement: 'top' | 'inline' | 'mixed' = 'top';
    if (constInlineCount > 0 && constTopCount > 0) constantsPlacement = 'mixed';
    else if (constInlineCount > constTopCount) constantsPlacement = 'inline';

    // Analyze Export Style
    let namedExports = 0;
    let defaultExports = 0;
    if (['typescript', 'javascript'].includes(language)) {
      lines.forEach((line: string) => {
        if (/^\s*export\s+default\b/.test(line)) defaultExports++;
        else if (/^\s*export\s+(?:(?:declare|abstract|async)\s+)*(?:const|let|var|function|class|interface|type|enum)\b|^\s*export\s*\{/.test(line)) namedExports++;
      });
    } else if (language === 'go') {
      lines.forEach((line: string) => {
        if (/^func\s+[A-Z]/.test(line.trim())) namedExports++;
      });
    } else if (language === 'rust') {
      lines.forEach((line: string) => {
        if (/^pub\s+fn/.test(line.trim())) namedExports++;
      });
    }

    let exportStyle: 'named' | 'default' | 'mixed' = 'named';
    if (defaultExports > 0 && namedExports > 0) exportStyle = 'mixed';
    else if (defaultExports > namedExports) exportStyle = 'default';

    // Analyze Imports
    const importedModules: string[] = [];
    if (['typescript', 'javascript'].includes(language)) {
      // Scan whole content so multi-line `import {\n a,\n b\n} from '...'` statements are captured
      const staticImportRegex = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g;
      const callImportRegex = /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
      for (const m of content.matchAll(staticImportRegex)) importedModules.push(m[1]);
      for (const m of content.matchAll(callImportRegex)) importedModules.push(m[1]);
    } else {
      let importRegex: RegExp | null = null;
      if (language === 'python') importRegex = /^(?:import|from)\s+([a-zA-Z0-9_\.]+)/;
      if (language === 'go') importRegex = /import\s+[\(\s]*["']([^"']+)["']/;
      if (language === 'rust') importRegex = /^use\s+([a-zA-Z0-9_:]+)/;
      if (language === 'java') importRegex = /^import\s+([a-zA-Z0-9_\.]+);/;

      if (importRegex) {
        lines.forEach((line: string) => {
          const match = line.trim().match(importRegex!);
          if (match && match[1]) {
            importedModules.push(match[1]);
          }
        });
      }
    }

    // Function metrics
    let funcCount = 0;
    let funcRegex = /(function\s+\w+|\w+\s*=\s*\(.*?\)\s*=>)/;
    if (language === 'python') funcRegex = /^\s*def\s+/;
    if (language === 'go') funcRegex = /^func\s+/;
    if (language === 'rust') funcRegex = /^\s*(pub\s+)?fn\s+/;
    if (language === 'java') funcRegex = /^\s*(public|private|protected)?\s+(static\s+)?\w+\s+\w+\s*\(/;

    lines.forEach((line: string) => {
      if (funcRegex.test(line)) funcCount++;
    });

    const avgFuncLength = funcCount > 0 ? Math.round(lines.length / funcCount) : lines.length;
    const typeCastingCount = (content.match(/as\s+[A-Z]\w*/g) || []).length;
    const hasTypeAnnotations = ['typescript', 'go', 'rust', 'java', 'cpp'].includes(language) || /:\s*(string|number|boolean|any)/.test(content);

    // Extract declared symbols (functions, classes, interfaces, types)
    const symbols = new Set<string>();
    const symbolMatches = content.matchAll(/(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g);
    for (const m of symbolMatches) {
      if (m[1]) symbols.add(m[1]);
    }

    // Also match const/let function definitions
    const arrowMatches = content.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g);
    for (const m of arrowMatches) {
      if (m[1]) symbols.add(m[1]);
    }

    // Python def/class/async def
    if (language === 'python') {
      const pyMatches = content.matchAll(/^(?:\s*)?(?:async\s+)?(?:def|class)\s+([A-Za-z0-9_]+)/gm);
      for (const m of pyMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // Go func, struct, interface
    if (language === 'go') {
      const goMatches = content.matchAll(/(?:func\s+(?:\([^)]+\)\s+)?|type\s+)([A-Za-z0-9_]+)\s*(?:struct|interface|\()/g);
      for (const m of goMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // Rust fn, struct, enum, trait
    if (language === 'rust') {
      const rustMatches = content.matchAll(/(?:pub\s+)?(?:fn|struct|enum|trait|type|impl)\s+([A-Za-z0-9_]+)/g);
      for (const m of rustMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // Java / C++ class, interface, method
    if (['java', 'cpp'].includes(language)) {
      const javaMatches = content.matchAll(/(?:class|interface|struct)\s+([A-Za-z0-9_]+)/g);
      for (const m of javaMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // Prisma models, enums and views
    if (ext === '.prisma') {
      for (const m of content.matchAll(/^\s*(?:model|enum|view|type)\s+([A-Za-z_]\w*)\s*\{/gm)) symbols.add(m[1]);
    }

    // SQL tables and views
    if (ext === '.sql') {
      const sqlMatches = content.matchAll(/CREATE\s+(?:TABLE|VIEW|PROCEDURE|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi);
      for (const m of sqlMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // When tree-sitter is initialised, its symbols and imports replace the regex ones for supported languages
    const tree = extractCodeFacts(filePath, content);
    const treeSymbols = tree?.symbols.map(s => s.name);
    const treeFunctions = tree?.symbols.filter(s => s.kind === 'function' || s.kind === 'method').length;

    return {
      filePath,
      language,
      constantsPlacement,
      constantCounts: { top: constTopCount, inline: constInlineCount },
      exportStyle,
      exportCounts: { named: namedExports, default: defaultExports },
      hasTypeAnnotations,
      typeCastingCount,
      importedModules: Array.from(new Set(tree ? tree.imports.map(i => i.specifier) : importedModules)),
      funcCount: treeFunctions ?? funcCount,
      avgFuncLength: treeFunctions ? Math.round(lines.length / treeFunctions) : avgFuncLength,
      symbols: Array.from(new Set(treeSymbols ?? symbols))
    };
  }

  /**
   * Lists every file the index covers (supported extension, <= 500KB, not excluded by the built-in
   * directory list, the repo-root .gitignore, or .codebaseignore / secret patterns), with the stats
   * used to detect changes since the last index build.
   */
  public static listSourceFiles(dirPath: string): SourceFileEntry[] {
    // While the MCP server watches the repo, patch the last listing with the paths that changed
    const changes = RepoWatch.takeChanges(dirPath);
    const cached = this.listingCache.get(dirPath);
    if (changes !== null && changes !== 'all' && cached && Date.now() - cached.walkedAt < FULL_WALK_MS) {
      const patched = this.patchListing(dirPath, cached.entries, changes);
      if (patched) {
        cached.entries = patched;
        return [...patched];
      }
    }
    const entries = this.walkSourceFiles(dirPath);
    if (changes !== null) this.listingCache.set(dirPath, { entries, walkedAt: Date.now() });
    return [...entries];
  }

  /** The listing with `changes` applied, or null when they need a full walk (directories or ignore rules changed). */
  private static patchListing(dirPath: string, entries: SourceFileEntry[], changes: Set<string>): SourceFileEntry[] | null {
    if (changes.size === 0) return entries;
    const gitignore = GitIgnoreRules.load(dirPath);
    const byPath = new Map(entries.map(e => [path.relative(dirPath, e.filePath).replace(/\\/g, '/'), e]));
    for (const rel of changes) {
      if (RULE_FILES.has(rel)) return null;
      const abs = path.join(dirPath, rel);
      const stats = this.statOf(abs);
      if (stats?.isDirectory()) return null;
      if (stats && this.isIndexablePath(dirPath, abs, gitignore)) {
        byPath.set(rel, { filePath: abs, mtimeMs: stats.mtimeMs, size: stats.size });
      } else {
        byPath.delete(rel);
        // A deleted directory: drop everything that was under it
        if (!stats) [...byPath.keys()].filter(k => k.startsWith(rel + '/')).forEach(k => byPath.delete(k));
      }
    }
    return [...byPath.values()];
  }

  private static walkSourceFiles(dirPath: string): SourceFileEntry[] {
    const entries: SourceFileEntry[] = [];
    const gitignore = GitIgnoreRules.load(dirPath);

    function walk(currentDir: string, isRoot: boolean) {
      let dirents: fs.Dirent[] = [];
      try {
        dirents = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      // A nested repository or git worktree (its own `.git` file or folder) is a separate checkout, not part of this one
      if (!isRoot && dirents.some(d => d.name === '.git')) return;
      for (const entry of dirents) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(dirPath, fullPath);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.includes(entry.name) && !gitignore.ignores(relPath, true)) {
            walk(fullPath, false);
          }
        } else if (entry.isFile()) {
          if (!SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
          if (gitignore.ignores(relPath, false) || CodebaseIgnore.isIgnoredFile(fullPath, dirPath)) continue;
          try {
            const stats = fs.statSync(fullPath);
            if (stats.size > MAX_FILE_BYTES) continue;
            entries.push({ filePath: fullPath, mtimeMs: stats.mtimeMs, size: stats.size });
          } catch {
            // Deleted between readdir and stat
          }
        }
      }
    }

    walk(dirPath, true);
    return entries;
  }

  /**
   * Applies the same path rules as listSourceFiles to a single file (used by the file watcher).
   */
  public static isIndexablePath(repoPath: string, filePath: string, gitignore: GitIgnoreRules = GitIgnoreRules.load(repoPath)): boolean {
    const relPath = path.relative(repoPath, filePath);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) return false;
    if (!SOURCE_EXTENSIONS.includes(path.extname(filePath).toLowerCase())) return false;
    const dirs = relPath.split(/[\\/]/).slice(0, -1);
    if (dirs.some(d => IGNORED_DIRS.includes(d))) return false;
    if (gitignore.ignores(relPath, false) || CodebaseIgnore.isIgnoredFile(filePath, repoPath)) return false;
    try {
      return fs.statSync(filePath).size <= MAX_FILE_BYTES;
    } catch {
      // Deleted files still count as indexable paths so the watcher can drop their chunks
      return true;
    }
  }

  public static scanDirectory(dirPath: string): ASTFact[] {
    const facts: ASTFact[] = [];
    // The listing already has each file's stats; facts are reused while they are unchanged
    this.listSourceFiles(dirPath).forEach(entry => {
      const fact = ASTExtractor.extractFileFacts(entry.filePath, entry);
      if (fact) facts.push(fact);
    });
    const last = this.lastScan.get(dirPath);
    if (last && last.length === facts.length && last.every((f, i) => f === facts[i])) return last;
    this.lastScan.set(dirPath, facts);
    return facts;
  }

  /** Lowercased file content (cached with the content), for case-insensitive text scans over many files. */
  public static readSourceFileLower(filePath: string): string | null {
    const content = this.readSourceFile(filePath);
    if (content === null) return null;
    const cached = this.contentCache.get(filePath) as (StatKey & { content: string; lower?: string }) | undefined;
    if (!cached || cached.content !== content) return content.toLowerCase();
    return cached.lower ??= content.toLowerCase();
  }
}
