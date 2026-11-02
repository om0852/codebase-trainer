import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { ImportResolver } from '../graph/importResolver.js';
import { CallSiteExtractor } from '../flow/callSites.js';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';
import { ContractDriftDetector } from '../microservices/contractDrift.js';
import { SecretSanitizer } from '../security/secretSanitizer.js';
import { VulnerabilityScanner } from '../security/vulnerabilityScanner.js';
import { ASTFact, CodebaseConvention } from '../types/index.js';
import { DiffFile, DiffLine, DiffParser } from './diffParser.js';

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface DiffFinding {
  ruleId: string;
  severity: FindingSeverity;
  filePath: string;
  line?: number;
  message: string;
  snippet?: string;
}

export interface DiffCheck {
  id: string;
  description: string;
}

export interface DiffCheckReport {
  status: 'passed' | 'failed' | 'no-changes' | 'invalid-input';
  // True when there are no error-severity findings; never true for invalid input
  passed: boolean;
  source: string;
  filesChecked: string[];
  addedLines: number;
  checksRun: DiffCheck[];
  findings: DiffFinding[];
  summary: string;
  notCovered: string[];
  error?: string;
}

export interface DiffCheckOptions {
  // A unified diff to check instead of reading git
  diff?: string;
  // Compare the working tree against this ref instead of HEAD (e.g. `main`)
  base?: string;
}

const CHECKS: DiffCheck[] = [
  { id: 'hardcoded-secret', description: 'Added lines containing API keys, tokens, private keys, JWTs or connection-string passwords (all files, including docs).' },
  { id: 'security-risk', description: 'Added eval/exec, SQL built by string concatenation, or disabled TLS verification.' },
  { id: 'removed-export-still-imported', description: 'Exports removed (or files deleted) by the diff that other files still import.' },
  { id: 'contract-drift', description: 'Client fetch/axios calls or route handlers added by the diff (outside tests) whose method, path or payload does not match the other side.' },
  { id: 'no-explicit-any', description: 'Added `any` types in TypeScript files when the codebase requires type annotations.' },
  { id: 'no-console-log', description: 'Added console.log in files that do not already log to the console (CLIs, tests and scripts are skipped).' },
  { id: 'sync-io-in-request-handler', description: 'Added synchronous fs/child_process calls in files that serve HTTP requests.' },
  { id: 'export-style', description: 'Added default exports where the learned convention is named exports (framework files that require default exports are skipped).' }
];

const NOT_COVERED = [
  'Authorization and permission logic, such as whether a scope or role grants more than its name implies',
  'Business rules, data validation and error handling',
  'Runtime behaviour: performance, concurrency and resource leaks',
  'Whether the change is tested',
  'Calls that changed signature (arguments added, removed or reordered)'
];

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_TS_EXTENSIONS = [...TS_EXTENSIONS, '.js', '.jsx', '.mjs', '.cjs'];
const DOC_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.rst'];
const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Checks a diff's added and removed lines against static rules and the codebase's learned conventions,
 * reporting every finding with a file and line. A pass means none of the listed checks matched; it is not
 * a full review, which is why the report always lists what was not checked.
 */
export class DiffChecker {
  public static readonly CHECKS = CHECKS;
  public static readonly NOT_COVERED = NOT_COVERED;

  public static check(repoPath: string, options: DiffCheckOptions = {}): DiffCheckReport {
    if (options.diff !== undefined && options.diff.trim() !== '') {
      if (!DiffParser.looksLikeDiff(options.diff)) {
        return this.invalid('provided diff', 'Input is not a unified diff (no `+++`/`@@` headers). Pass the output of `git diff`, or omit `diff` to check the working tree against HEAD.');
      }
      return this.checkFiles(repoPath, DiffParser.parse(options.diff), 'provided diff');
    }

    const git = this.readGitDiff(repoPath, options.base);
    if (git.error) return this.invalid(git.source, git.error);
    const files = DiffParser.parse(git.diff);
    git.untracked.forEach(rel => {
      try {
        files.push(DiffParser.asAddedFile(rel, fs.readFileSync(path.join(repoPath, rel), 'utf8')));
      } catch {
        // Unreadable untracked file; nothing to check
      }
    });
    return this.checkFiles(repoPath, files, git.untracked.length > 0 ? `${git.source} + ${git.untracked.length} untracked file(s)` : git.source);
  }

  /**
   * Runs the checks on already-parsed diff files.
   */
  public static checkFiles(repoPath: string, files: DiffFile[], source: string): DiffCheckReport {
    const addedLines = files.reduce((n, f) => n + f.addedLines.length, 0);
    if (files.length === 0) {
      return this.report('no-changes', source, [], 0, [], 'No changes to check.');
    }

    const conventions = ConventionMiner.loadConventions(repoPath);
    const findings: DiffFinding[] = [];
    files.forEach(file => findings.push(...this.checkLines(repoPath, file, conventions)));
    findings.push(...this.checkRemovedExports(repoPath, files));
    findings.push(...this.checkContractDrift(repoPath, files));

    const unique = new Map<string, DiffFinding>();
    findings.forEach(f => unique.set(`${f.ruleId}|${f.filePath}|${f.line}|${f.message}`, f));
    const sorted = Array.from(unique.values()).sort((a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.filePath.localeCompare(b.filePath) || (a.line || 0) - (b.line || 0)
    );

    const errors = sorted.filter(f => f.severity === 'error').length;
    const warnings = sorted.filter(f => f.severity === 'warning').length;
    const infos = sorted.length - errors - warnings;
    const scope = `${files.length} changed file(s), ${addedLines} added line(s)`;
    const summary = sorted.length === 0
      ? `No findings from ${CHECKS.length} static checks across ${scope}. This is not a full review; see notCovered.`
      : `${errors} error(s), ${warnings} warning(s), ${infos} info across ${scope}.`;
    return this.report(errors > 0 ? 'failed' : 'passed', source, files.map(f => f.filePath), addedLines, sorted, summary);
  }

  public static readGitDiff(repoPath: string, base?: string): { diff: string; untracked: string[]; source: string; error?: string } {
    const ref = base || 'HEAD';
    const source = `git diff ${ref}`;
    if (!/^[\w./~^@{}-]+$/.test(ref)) {
      return { diff: '', untracked: [], source, error: `Invalid base ref: ${ref}` };
    }
    try {
      const run = (cmd: string) => execSync(cmd, { cwd: repoPath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const diff = run(`git diff ${ref} --no-color --no-ext-diff`);
      // `git diff` does not show new files that were never added; check them as fully added
      const untracked = run('git ls-files --others --exclude-standard')
        .split(/\r?\n/)
        .filter(Boolean)
        .filter(rel => ASTExtractor.isIndexablePath(repoPath, path.join(repoPath, rel)) || DOC_EXTENSIONS.includes(path.extname(rel).toLowerCase()));
      return { diff, untracked, source };
    } catch (err) {
      const failure = err as { stderr?: string; message?: string };
      const detail = String(failure.stderr || failure.message || err).trim().split('\n')[0];
      return { diff: '', untracked: [], source, error: `Could not read ${source}: ${detail}` };
    }
  }

  private static checkLines(repoPath: string, file: DiffFile, conventions: CodebaseConvention | null): DiffFinding[] {
    const findings: DiffFinding[] = [];
    const ext = path.extname(file.filePath).toLowerCase();
    const isDoc = DOC_EXTENSIONS.includes(ext);
    const isJsTs = JS_TS_EXTENSIONS.includes(ext);
    const isTs = TS_EXTENSIONS.includes(ext);
    const isTest = IntentClassifier.isTestFile(file.filePath);
    const isPython = ext === '.py';
    const current = this.readCurrent(repoPath, file.filePath);
    // File-level signals are read from code only, so patterns quoted in comments, strings or regex literals don't count
    const currentCode = (isPython ? current : current.replace(/\/\*[\s\S]*?\*\//g, ''))
      .split(/\r?\n/).map(l => this.stripStringsAndComments(l, isPython)).join('\n');
    const addedCode = file.addedLines.map(l => this.stripStringsAndComments(l.text, isPython));

    // The file's existing style (lines not added by this diff) decides whether a pattern is already accepted there
    const existingCount = (regex: RegExp) =>
      Math.max(0, (currentCode.match(new RegExp(regex.source, 'g')) || []).length - addedCode.filter(t => regex.test(t)).length);
    const isCliOrScript = /^#!/.test(current) || /\.command\(\s*['"`]/.test(currentCode) || /(^|\/)(scripts?|bin|examples?|bench(marks?)?|tools)\//.test(file.filePath);
    const servesHttp = isJsTs && (
      /(^|\/)route\.(t|j)s$/.test(file.filePath) || /(^|\/)pages\/api\//.test(file.filePath)
      || /\b(?:app|router|server)\.(?:get|post|put|delete|patch)\s*\(\s*['"`]/.test(currentCode)
      || /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|DELETE|PATCH)\s*\(/.test(currentCode)
    );
    const isFrameworkDefaultExport = IntentClassifier.requiresDefaultExport(file.filePath);
    const consoleLogAccepted = isTest || isCliOrScript || existingCount(/console\.log\(/) > 0;
    const anyRequired = isTs && (!conventions || conventions.rules.structural.typeAnnotationRequirement === true);

    const add = (ruleId: string, severity: FindingSeverity, l: DiffLine, message: string) =>
      findings.push({ ruleId, severity, filePath: file.filePath, line: l.line, message, snippet: l.text.trim().slice(0, 200) });

    file.addedLines.forEach(l => {
      const secrets = SecretSanitizer.detectSecrets(l.text);
      const scanner = VulnerabilityScanner.scanLine(l.text);
      if (secrets.length > 0 || scanner.some(r => r.severity === 'CRITICAL')) {
        add('hardcoded-secret', 'error', l, `Hardcoded secret added (${[...secrets, ...scanner.filter(r => r.severity === 'CRITICAL').map(r => r.id)].join(', ')}). Move it to an environment variable or secret store, and rotate it if it was ever committed.`);
      }
      if (isDoc) return;

      const comment = isPython ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
      if (comment.test(l.text)) return;
      const code = this.stripStringsAndComments(l.text, isPython);

      scanner.filter(r => r.severity !== 'CRITICAL').forEach(r => {
        add('security-risk', r.severity === 'HIGH' ? 'error' : 'warning', l, `${r.desc} (${r.id})`);
      });
      if (anyRequired && /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/.test(code)) {
        add('no-explicit-any', 'warning', l, 'Explicit `any` added; use a concrete type, a generic, or `unknown`.');
      }
      if (isJsTs && !consoleLogAccepted && /console\.log\(/.test(code)) {
        add('no-console-log', 'warning', l, 'console.log added in a file that does not otherwise log to the console; remove it or use the project logger.');
      }
      if (servesHttp && /\b(?:readFileSync|writeFileSync|appendFileSync|existsSync|readdirSync|execSync|spawnSync)\s*\(/.test(code)) {
        add('sync-io-in-request-handler', 'warning', l, 'Synchronous I/O added in a file that serves HTTP requests; it blocks the event loop for every concurrent request. Use the async API.');
      }
      if (isJsTs && !isTest && !isFrameworkDefaultExport && conventions?.rules.structural.exportStyle === 'named' && /^\s*export\s+default\b/.test(l.text)) {
        add('export-style', 'info', l, 'Default export added; this codebase uses named exports.');
      }
    });
    return findings;
  }

  /**
   * Exports deleted by the diff (or whole deleted files) that other files still import.
   */
  private static checkRemovedExports(repoPath: string, files: DiffFile[]): DiffFinding[] {
    const candidates = files
      .filter(f => JS_TS_EXTENSIONS.includes(path.extname(f.oldPath || f.filePath).toLowerCase()) && (f.removedLines.length > 0 || f.status === 'deleted'))
      .map(f => {
        const oldRel = f.status === 'renamed' && f.oldPath ? f.oldPath : f.filePath;
        const current = f.status === 'deleted' || f.status === 'renamed' ? '' : this.readCurrent(repoPath, f.filePath);
        const removed = new Set<string>();
        f.removedLines.forEach(l => this.exportedNames(l.text).forEach(n => removed.add(n)));
        const stillExported = this.exportedNames(current);
        stillExported.forEach(n => removed.delete(n));
        return { file: f, oldRel, removed, wholeFile: f.status === 'deleted' || f.status === 'renamed' };
      })
      .filter(c => c.wholeFile || c.removed.size > 0);
    if (candidates.length === 0) return [];

    const facts = ASTExtractor.scanDirectory(repoPath);
    // Deleted or renamed-away files are no longer on disk; add them so imports of the old path still resolve
    const known = new Set(facts.map(f => path.resolve(f.filePath)));
    candidates.forEach(c => {
      const abs = path.join(repoPath, c.oldRel);
      if (!known.has(path.resolve(abs))) {
        facts.push({ filePath: abs, language: 'typescript', importedModules: [] } as unknown as ASTFact);
      }
    });
    const resolver = ImportResolver.forFacts(repoPath, facts);
    const changed = new Set(files.map(f => f.filePath));

    const findings: DiffFinding[] = [];
    facts.forEach(importer => {
      const rel = path.relative(repoPath, importer.filePath).replace(/\\/g, '/');
      if (!JS_TS_EXTENSIONS.includes(path.extname(rel).toLowerCase())) return;
      const content = this.readCurrent(repoPath, rel);
      if (!content) return;

      CallSiteExtractor.parseJsImports(content, true).bindings.forEach(binding => {
        const target = resolver.resolve(importer.filePath, binding.specifier, 'typescript');
        if (!target) return;
        const targetRel = path.relative(repoPath, target).replace(/\\/g, '/');
        const candidate = candidates.find(c => c.oldRel === targetRel);
        if (!candidate || targetRel === rel) return;

        const name = binding.imported === 'default' ? 'default' : binding.imported;
        if (candidate.wholeFile) {
          const what = candidate.file.status === 'renamed' ? `was renamed to ${candidate.file.filePath}` : 'was deleted';
          findings.push({
            ruleId: 'removed-export-still-imported',
            severity: 'error',
            filePath: rel,
            line: binding.line,
            message: `Imports \`${binding.local}\` from ${targetRel}, which ${what}${changed.has(rel) ? '' : ' (this file is not part of the diff)'}.`
          });
        } else if (binding.imported !== '*' && candidate.removed.has(name)) {
          findings.push({
            ruleId: 'removed-export-still-imported',
            severity: 'error',
            filePath: rel,
            line: binding.line,
            message: `Imports \`${binding.imported}\` from ${targetRel}, but the diff removes that export${changed.has(rel) ? '' : ' (this file is not part of the diff)'}.`
          });
        }
      });
    });
    return findings;
  }

  /**
   * Contract drift issues located on lines this diff added.
   */
  private static checkContractDrift(repoPath: string, files: DiffFile[]): DiffFinding[] {
    const addedByFile = new Map<string, Set<number>>();
    files.forEach(f => addedByFile.set(f.filePath, new Set(f.addedLines.map(l => l.line))));
    const touchesCode = files.some(f => [...JS_TS_EXTENSIONS, '.py'].includes(path.extname(f.filePath).toLowerCase()) && f.addedLines.length > 0);
    if (!touchesCode) return [];

    const norm = (p?: string) => (p || '').replace(/\\/g, '/');
    const findings: DiffFinding[] = [];
    ContractDriftDetector.detectDrift(repoPath).issues.forEach(issue => {
      const sides: Array<{ file?: string; line?: number }> = [
        { file: norm(issue.clientFile), line: issue.clientLine },
        { file: norm(issue.serverFile), line: issue.serverLine }
      ];
      // Tests mock fetch calls and fixture routes freely; drift there is not a contract problem
      const hit = sides.find(s => s.file && s.line && !IntentClassifier.isTestFile(s.file) && addedByFile.get(s.file)?.has(s.line));
      if (!hit) return;
      findings.push({
        ruleId: 'contract-drift',
        severity: issue.severity,
        filePath: hit.file!,
        line: hit.line,
        message: `${issue.description}${issue.suggestedFix ? ` ${issue.suggestedFix}` : ''}`
      });
    });
    return findings;
  }

  // Names exported by declarations or `export { a, b as c }` (without `from`) in a piece of source
  private static exportedNames(text: string): Set<string> {
    const names = new Set<string>();
    for (const m of text.matchAll(/^\s*export\s+(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([\w$]+)/gm)) {
      names.add(m[1] ? 'default' : m[2]);
    }
    if (/^\s*export\s+default\b/m.test(text)) names.add('default');
    for (const m of text.matchAll(/^\s*export\s*\{([^}]*)\}(?!\s*from)/gm)) {
      m[1].split(',').forEach(item => {
        const parts = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        const exported = (parts[1] || parts[0]).trim();
        if (exported) names.add(exported);
      });
    }
    return names;
  }

  private static stripStringsAndComments(text: string, isPython: boolean): string {
    // Regex literals first (they may contain quotes); a `/` after an operator or bracket starts one, not a division
    const noRegex = isPython ? text : text.replace(/(^|[=(,:!&|?{};[]\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[dgimsuy]*/g, '$1/re/');
    const noStrings = noRegex.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    return isPython ? noStrings.replace(/#.*$/, '') : noStrings.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  }

  private static readCurrent(repoPath: string, rel: string): string {
    try {
      return fs.readFileSync(path.join(repoPath, rel), 'utf8');
    } catch {
      return '';
    }
  }

  private static invalid(source: string, error: string): DiffCheckReport {
    return { ...this.report('invalid-input', source, [], 0, [], error), passed: false, error };
  }

  private static report(
    status: DiffCheckReport['status'],
    source: string,
    filesChecked: string[],
    addedLines: number,
    findings: DiffFinding[],
    summary: string
  ): DiffCheckReport {
    return {
      status,
      passed: status === 'passed' || status === 'no-changes',
      source,
      filesChecked,
      addedLines,
      checksRun: CHECKS,
      findings,
      summary,
      notCovered: NOT_COVERED
    };
  }
}
