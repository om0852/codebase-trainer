import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';
import { extractCodeFacts } from '../parsing/codeFacts.js';
import { ImportResolver } from './importResolver.js';

/**
 * Test impact: the tests to run for a change. A test is affected when it imports the changed code (directly or
 * through other modules), when it is the changed code, or when it names a changed symbol or file. The selection
 * comes with a command for each detected runner (vitest, jest, node:test, mocha, playwright, pytest).
 */

export interface AffectedTest {
  file: string;
  via: 'changed' | 'import' | 'name';
  // Import hops from the changed file (0 for a changed test, 1 for a direct import)
  distance: number;
  reason: string;
}

export interface TestCommand {
  runner: string;
  // Directory to run the command from, relative to the repo root ('.' for the root)
  cwd: string;
  command: string;
  tests: string[];
}

export interface TestImpact {
  targets: string[];
  tests: AffectedTest[];
  commands: TestCommand[];
  // Test files in the repo, for comparing the selection with running everything
  totalTests: number;
  notes: string[];
}

// Imports are followed this many hops back from the changed file
const MAX_DEPTH = 8;
// Symbol names too short or generic to identify a test by name
// Files a runner executes (helpers and mocks in test folders are followed like source code)
const RUNNABLE_TEST = /[._-](?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/;
const GENERIC_NAMES = new Set(['index', 'main', 'default', 'utils', 'helpers', 'types', 'config', 'constants', 'handler', 'router', 'app', 'server', 'client', 'service', 'model', 'schema', 'test', 'setup']);

export class TestImpactAnalyzer {
  /**
   * Tests affected by changing `targets` (repo-relative files, or symbol names). `symbols` adds changed symbol
   * names for the name match, e.g. the functions a diff touched.
   */
  public static forTargets(repoPath: string, targets: string[], symbols: string[] = []): TestImpact {
    const facts = ASTExtractor.scanDirectory(repoPath);
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');
    const resolver = ImportResolver.forFacts(repoPath, facts);
    const notes: string[] = [];

    const targetFiles = new Set<string>();
    const names = new Set(symbols);
    targets.forEach(target => {
      const file = resolver.findFile(target);
      if (file) {
        targetFiles.add(file);
      } else {
        const declaring = facts.filter(f => (f.symbols || []).includes(target)).map(f => f.filePath);
        declaring.forEach(f => targetFiles.add(f));
        names.add(target);
        if (declaring.length === 0) notes.push(`\`${target}\` did not match an indexed file or declared symbol.`);
      }
    });

    const testFiles = facts.filter(f => IntentClassifier.isTestFile(toRel(f.filePath)) && RUNNABLE_TEST.test(toRel(f.filePath)));
    const isTest = new Set(testFiles.map(f => f.filePath));
    const found = new Map<string, AffectedTest>();
    const add = (abs: string, test: AffectedTest) => {
      const existing = found.get(abs);
      if (!existing || test.distance < existing.distance) found.set(abs, test);
    };

    // 1. Changed tests run themselves
    targetFiles.forEach(f => {
      if (isTest.has(f)) add(f, { file: toRel(f), via: 'changed', distance: 0, reason: 'changed test file' });
    });

    // 2. Tests that import the changed files, directly or through other modules (not through other tests)
    const importers = ImportResolver.invertGraph(ImportResolver.buildImportGraph(repoPath, facts));
    targetFiles.forEach(start => {
      const parent = new Map<string, string>();
      const depth = new Map<string, number>([[start, 0]]);
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift()!;
        const d = depth.get(current)!;
        if (d >= MAX_DEPTH) continue;
        (importers[current] || []).forEach(importer => {
          if (depth.has(importer)) return;
          depth.set(importer, d + 1);
          parent.set(importer, current);
          if (isTest.has(importer)) {
            const chain: string[] = [];
            for (let at: string | undefined = current; at && at !== start; at = parent.get(at)) chain.push(toRel(at));
            const through = chain.length > 0 ? ` via ${chain.reverse().join(' -> ')}` : '';
            add(importer, { file: toRel(importer), via: 'import', distance: d + 1, reason: `imports ${toRel(start)}${through}` });
          } else {
            queue.push(importer);
          }
        });
      }
    });

    // 3. Tests that name a changed file or symbol but reach it some other way (mocks, subprocesses, fixtures)
    const fileStems = [...targetFiles].filter(f => !isTest.has(f)).map(f => path.basename(f).replace(/\.[^.]+$/, ''));
    // A changed file's exported top-level declarations count as changed names too (not its methods or locals)
    [...targetFiles].filter(f => !isTest.has(f)).forEach(f => {
      const tree = extractCodeFacts(f, ASTExtractor.readSourceFile(f) ?? '');
      if (tree) {
        tree.symbols.filter(s => s.exported && !s.nestedInFunction && s.kind !== 'method').forEach(s => names.add(s.name));
      } else {
        // Regex fallback: the extractor's declared names
        (facts.find(fact => fact.filePath === f)?.symbols ?? []).forEach(s => names.add(s));
      }
    });
    const wanted = [...new Set([...names, ...fileStems])].filter(n => n.length >= 4 && !GENERIC_NAMES.has(n.toLowerCase()));
    if (wanted.length > 0) {
      const pattern = new RegExp(`\\b(?:${wanted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
      testFiles.filter(f => !found.has(f.filePath)).forEach(f => {
        const stem = path.basename(f.filePath).replace(/(?:[._-](?:test|spec))?\.[^.]+$/, '').replace(/^test_/, '');
        const byFileName = fileStems.includes(stem);
        const match = byFileName ? stem : (ASTExtractor.readSourceFile(f.filePath) ?? '').match(pattern)?.[0];
        if (match) add(f.filePath, { file: toRel(f.filePath), via: 'name', distance: MAX_DEPTH + 1, reason: byFileName ? `named after ${match}` : `mentions ${match}` });
      });
    }

    const tests = [...found.values()].sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
    if (tests.length === 0 && targetFiles.size > 0) notes.push('No test imports or names the changed code.');
    notes.push('Import-based: tests that reach the code only at runtime (an HTTP call to a running server, a spawned CLI, dynamic imports with computed paths) are found only when they name the changed file or symbol.');
    return {
      targets: [...targetFiles].map(toRel),
      tests,
      commands: this.commands(repoPath, tests.map(t => t.file)),
      totalTests: testFiles.length,
      notes
    };
  }

  /**
   * Tests affected by a diff: its changed files plus the symbols whose bodies it touched.
   */
  public static forChangedFiles(repoPath: string, files: Array<{ filePath: string; status: string; addedLines: Array<{ line: number }> }>): TestImpact {
    const symbols = new Set<string>();
    files.forEach(f => {
      if (f.status === 'deleted') return;
      const abs = path.join(repoPath, f.filePath);
      const content = ASTExtractor.readSourceFile(abs);
      if (content === null) return;
      const changed = new Set(f.addedLines.map(l => l.line));
      extractCodeFacts(abs, content)?.symbols
        .filter(s => !s.nestedInFunction && [...changed].some(line => line >= s.startLine && line <= s.endLine))
        .forEach(s => symbols.add(s.name));
    });
    return this.forTargets(repoPath, files.filter(f => f.status !== 'deleted').map(f => f.filePath), [...symbols]);
  }

  /**
   * One command per runner and package: `npx vitest run a.test.ts`, `pytest tests/test_x.py`, ...
   */
  public static commands(repoPath: string, testFiles: string[]): TestCommand[] {
    const groups = new Map<string, TestCommand>();
    testFiles.forEach(file => {
      const pkgDir = this.packageDirOf(repoPath, file);
      const runner = this.runnerFor(repoPath, pkgDir, file);
      const key = `${pkgDir}|${runner}`;
      const relToPkg = path.posix.relative(pkgDir === '.' ? '' : pkgDir, file);
      const group = groups.get(key) ?? { runner, cwd: pkgDir, command: '', tests: [] };
      group.tests.push(relToPkg);
      groups.set(key, group);
    });
    groups.forEach(group => {
      const quoted = group.tests.map(t => /[\s()[\]$&]/.test(t) ? `"${t}"` : t).join(' ');
      const base = {
        vitest: `npx vitest run ${quoted}`,
        jest: `npx jest ${quoted}`,
        playwright: `npx playwright test ${quoted}`,
        mocha: `npx mocha ${quoted}`,
        'node:test (tsx)': `npx tsx --test ${quoted}`,
        'node:test': `node --test ${quoted}`,
        pytest: `pytest ${quoted}`,
        unknown: `# no test runner detected; tests: ${quoted}`
      }[group.runner] ?? quoted;
      group.command = group.cwd === '.' ? base : `cd ${group.cwd} && ${base}`;
    });
    return [...groups.values()];
  }

  /** Nearest directory at or above the test with a package.json / pyproject.toml, within the repo. */
  private static packageDirOf(repoPath: string, file: string): string {
    let dir = path.posix.dirname(file);
    while (dir !== '.' && dir !== '') {
      if (['package.json', 'pyproject.toml', 'setup.cfg', 'pytest.ini'].some(m => fs.existsSync(path.join(repoPath, dir, m)))) return dir;
      dir = path.posix.dirname(dir);
    }
    return '.';
  }

  private static runnerFor(repoPath: string, pkgDir: string, file: string): string {
    if (file.endsWith('.py')) return 'pytest';
    const content = ASTExtractor.readSourceFile(path.join(repoPath, file)) ?? '';
    // Import statements at the start of a line, so a fixture string that contains one does not count
    const imports = (module: string) => new RegExp(`^\\s*import\\b[^\\n]*['"]${module}['"]|^[^'"\\n]*require\\(['"]${module}['"]\\)`, 'm').test(content);
    if (imports('@playwright/test')) return 'playwright';
    if (imports('vitest')) return 'vitest';
    if (imports('node:test')) return this.usesTsx(repoPath, pkgDir) || /\.[cm]?tsx?$/.test(file) ? 'node:test (tsx)' : 'node:test';

    // Otherwise whatever the package (or the repo root) declares
    for (const dir of [...new Set([pkgDir, '.'])]) {
      const manifest = this.readManifest(repoPath, dir);
      if (!manifest) continue;
      const deps = { ...manifest.dependencies, ...manifest.devDependencies };
      const script = `${manifest.scripts?.test ?? ''}`;
      if ('vitest' in deps || /\bvitest\b/.test(script)) return 'vitest';
      if ('jest' in deps || /\bjest\b/.test(script)) return 'jest';
      if ('mocha' in deps || /\bmocha\b/.test(script)) return 'mocha';
      if (/--test\b/.test(script)) return /\btsx\b/.test(script) ? 'node:test (tsx)' : 'node:test';
    }
    return 'unknown';
  }

  private static usesTsx(repoPath: string, pkgDir: string): boolean {
    return [pkgDir, '.'].some(dir => /\btsx\b/.test(this.readManifest(repoPath, dir)?.scripts?.test ?? ''));
  }

  private static readManifest(repoPath: string, dir: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(repoPath, dir, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
  }
}
