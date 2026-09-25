import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { SemanticSearchEngine } from '../semantic/searchEngine.js';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { CallGraphAnalyzer } from '../graph/callGraph.js';
import { DashboardGenerator } from '../ui/dashboardGenerator.js';

export class CodebaseWatcher {
  private static debounceTimer: NodeJS.Timeout | null = null;
  private static changedFiles = new Set<string>();

  public static watch(repoPath: string, onUpdate?: (changedFiles: string[]) => void): void {
    const absoluteRepoPath = path.resolve(repoPath);
    console.log(`👀 Starting real-time background file watcher at: ${absoluteRepoPath}`);
    console.log(`⚡ Watching for file changes (.ts, .js, .py, .go, .rs, .java, .cpp, .json, .md)...`);
    console.log(`Press Ctrl+C to stop watching.\n`);

    const ignoreDirs = [
      'node_modules', '.git', '.codebase', 'dist', 'build', '.next', 'vendor',
      'target', '.venv', 'venv', 'env', '.env', '__pycache__', 'coverage',
      '.pytest_cache', 'site-packages', '.cache', 'lib', 'Lib', 'data', 'models'
    ];

    const validExtensions = [
      '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
      '.c', '.cpp', '.h', '.hpp', '.json', '.md'
    ];

    try {
      fs.watch(absoluteRepoPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        const normPath = filename.replace(/\\/g, '/');
        // Check ignored directories
        if (ignoreDirs.some(dir => normPath.startsWith(dir + '/') || normPath.includes('/' + dir + '/'))) {
          return;
        }

        const ext = path.extname(filename).toLowerCase();
        if (!validExtensions.includes(ext)) return;

        const fullPath = path.join(absoluteRepoPath, filename);
        this.changedFiles.add(fullPath);

        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
          const filesToProcess = Array.from(this.changedFiles);
          this.changedFiles.clear();
          this.processChanges(absoluteRepoPath, filesToProcess, onUpdate);
        }, 500);
      });
    } catch (err: any) {
      console.error(`❌ Watcher error: ${err.message}`);
    }
  }

  private static processChanges(repoPath: string, files: string[], onUpdate?: (files: string[]) => void): void {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] 🔄 Change detected in ${files.length} file(s):`);
    files.forEach(f => console.log(`   - ${path.relative(repoPath, f)}`));

    try {
      // Re-scan AST facts & update semantic BM25 index
      const facts = ASTExtractor.scanDirectory(repoPath);
      SemanticSearchEngine.buildIndex(repoPath);
      
      // Update conventions & dashboard
      const conventions = ConventionMiner.generateConventions(repoPath, facts);
      ConventionMiner.saveConventions(repoPath, conventions);

      const graph = CallGraphAnalyzer.analyzeGraph(repoPath);
      DashboardGenerator.generateHTML(repoPath, conventions, graph);

      console.log(`[${timestamp}] ✅ Model re-indexed successfully. Conventions & vector embeddings updated.\n`);
      if (onUpdate) onUpdate(files);
    } catch (err: any) {
      console.error(`[${timestamp}] ⚠️ Re-indexing failed: ${err.message}`);
    }
  }
}
