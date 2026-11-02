import * as path from 'path';
import { ASTFact } from '../types/index.js';

export type ArchitecturalRole =
  | 'page'
  | 'controller_route'
  | 'middleware'
  | 'ui_component'
  | 'hook'
  | 'store'
  | 'service_business_logic'
  | 'data_model'
  | 'cli_entry'
  | 'utility_helper'
  | 'test_spec'
  | 'configuration'
  | 'documentation'
  | 'script'
  | 'unknown';

export interface FileRoleFact {
  filePath: string;
  role: ArchitecturalRole;
  confidence: number;
}

export interface RoleSummary {
  count: number;
  examples: string[];
}

export interface ArchitectureSummary {
  // Role -> how many files and up to three example paths, so an agent sees the shape without a full file list
  roles: Partial<Record<ArchitecturalRole, RoleSummary>>;
  // Top-level source directories (e.g. `src/graph`) -> file count
  directories: Record<string, number>;
}

const MAX_EXAMPLES = 3;
const MAX_DIRECTORIES = 20;
const SOURCE_ROOTS = new Set(['src', 'app', 'lib', 'packages', 'apps', 'server', 'client', 'pkg', 'internal', 'cmd']);

export class IntentClassifier {
  /**
   * Classifies a file by its repo-relative path. Rules match whole path segments and filename patterns
   * (never substrings, so `modelValidator.ts` is not a data model and `latest.ts` is not a test).
   */
  public static classifyPath(relPath: string): FileRoleFact {
    const rel = relPath.replace(/\\/g, '/');
    const segments = rel.toLowerCase().split('/');
    const dirs = new Set(segments.slice(0, -1));
    const fileName = path.basename(rel);
    const lowerName = fileName.toLowerCase();
    const ext = path.extname(lowerName);
    const stem = lowerName.slice(0, lowerName.length - ext.length);
    const result = (role: ArchitecturalRole, confidence: number): FileRoleFact => ({ filePath: relPath, role, confidence });
    const hasDir = (...names: string[]) => names.some(n => dirs.has(n));

    if (hasDir('test', 'tests', '__tests__', 'spec', 'specs', 'e2e', '__mocks__') || /\.(test|spec|e2e)$/.test(stem)) return result('test_spec', 0.95);
    if (['.md', '.markdown', '.mdx', '.rst', '.txt'].includes(ext)) return result('documentation', 0.95);
    if (['.json', '.yaml', '.yml', '.toml', '.ini'].includes(ext) || /(^|\.)config$/.test(stem) || /^\.[\w-]+rc$/.test(stem) || stem.startsWith('.env')) {
      return result('configuration', 0.9);
    }
    if (stem === 'middleware' || hasDir('middleware', 'middlewares')) return result('middleware', 0.9);
    if (stem === 'route' || hasDir('api', 'routes', 'controllers', 'handlers', 'endpoints') || /\.(controller|routes?|handler)$/.test(stem) || /controller$/.test(stem)) {
      return result('controller_route', 0.9);
    }
    if (['page', 'layout', 'template', 'loading', 'error', 'not-found'].includes(stem) && hasDir('app')) return result('page', 0.95);
    if (hasDir('pages', 'views', 'screens') && ['.tsx', '.jsx', '.vue', '.svelte', '.ts', '.js'].includes(ext)) return result('page', 0.85);
    if (/^use[A-Z]/.test(fileName) || hasDir('hooks', 'composables')) return result('hook', 0.9);
    if (hasDir('store', 'stores', 'state', 'redux', 'slices') || /(store|slice)$/.test(stem)) return result('store', 0.85);
    if (hasDir('components', 'ui', 'widgets') || ['.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) return result('ui_component', 0.85);
    if (hasDir('models', 'entities', 'schemas', 'types', 'prisma', 'migrations') || /\.(model|entity|schema|dto)$/.test(stem) || stem === 'types' || ext === '.sql' || ext === '.prisma') {
      return result('data_model', 0.85);
    }
    if (hasDir('cli', 'bin', 'commands', 'cmd')) return result('cli_entry', 0.85);
    if (hasDir('scripts')) return result('script', 0.85);
    if (hasDir('services', 'domain', 'core', 'usecases') || /(service|\.service)$/.test(stem)) return result('service_business_logic', 0.8);
    if (hasDir('utils', 'util', 'helpers', 'shared', 'common') || /^(utils?|helpers?)$/.test(stem)) return result('utility_helper', 0.8);
    return result('unknown', 0.5);
  }

  public static isTestFile(relPath: string): boolean {
    return this.classifyPath(relPath).role === 'test_spec';
  }

  public static classifyFile(fact: ASTFact, repoPath?: string): FileRoleFact {
    const rel = repoPath ? path.relative(repoPath, fact.filePath) : fact.filePath;
    return { ...this.classifyPath(rel), filePath: fact.filePath };
  }

  /**
   * Framework files that must use a default export (Next.js app/pages files, config files, stories).
   */
  public static requiresDefaultExport(relPath: string): boolean {
    const rel = relPath.replace(/\\/g, '/');
    return /(^|\/)(page|layout|route|middleware|loading|error|not-found|template)\.(t|j)sx?$/.test(rel)
      || /(^|\/)pages\//.test(rel) || /\.config\.[cm]?[jt]s$/.test(rel) || /\.(stories|story)\.[jt]sx?$/.test(rel);
  }

  /**
   * Module a file belongs to: the second-level directory under a source root (`src/graph`), otherwise the
   * top-level directory (`website`). Files at the repo root return null.
   */
  public static moduleOf(relPath: string): string | null {
    const segments = relPath.replace(/\\/g, '/').split('/');
    if (segments.length <= 1) return null;
    return SOURCE_ROOTS.has(segments[0]) && segments.length > 2 ? `${segments[0]}/${segments[1]}` : segments[0];
  }

  public static summarizeArchitecture(repoPath: string, facts: ASTFact[]): ArchitectureSummary {
    const roles: ArchitectureSummary['roles'] = {};
    const directories: Record<string, number> = {};

    facts.forEach(f => {
      const rel = path.relative(repoPath, f.filePath).replace(/\\/g, '/');
      const { role } = this.classifyPath(rel);
      const entry = roles[role] || (roles[role] = { count: 0, examples: [] });
      entry.count++;
      if (entry.examples.length < MAX_EXAMPLES) entry.examples.push(rel);

      const dir = this.moduleOf(rel);
      if (dir) directories[dir] = (directories[dir] || 0) + 1;
    });

    const topDirectories = Object.fromEntries(
      Object.entries(directories).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_DIRECTORIES)
    );
    return { roles, directories: topDirectories };
  }
}
