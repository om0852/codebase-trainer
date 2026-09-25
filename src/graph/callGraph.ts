import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';

export interface FunctionNode {
  name: string;
  filePath: string;
  line: number;
  calls: string[];
}

export interface DependencyGraph {
  nodes: Record<string, FunctionNode>;
  importsMap: Record<string, string[]>;
  qualityIssues: Array<{
    type: 'circular_dependency' | 'high_complexity' | 'dead_code_warning' | 'sync_io_hotpath';
    filePath: string;
    line?: number;
    description: string;
    severity: 'error' | 'warning' | 'info';
  }>;
}

export class CallGraphAnalyzer {
  public static analyzeGraph(repoPath: string): DependencyGraph {
    const facts = ASTExtractor.scanDirectory(repoPath);
    const nodes: Record<string, FunctionNode> = {};
    const importsMap: Record<string, string[]> = {};
    const qualityIssues: DependencyGraph['qualityIssues'] = [];

    facts.forEach(fact => {
      importsMap[fact.filePath] = fact.importedModules;

      if (!fs.existsSync(fact.filePath)) return;
      let content = '';
      try {
        content = fs.readFileSync(fact.filePath, 'utf8');
      } catch {
        return;
      }

      const lines = content.split(/\r?\n/);

      // Check Synchronous I/O in Hot Paths or Loops
      let insideLoop = false;
      lines.forEach((line, idx) => {
        if (/for\s*\(|while\s*\(|\.forEach\(|\.map\(/.test(line)) {
          insideLoop = true;
        }
        if (insideLoop && /(readFileSync|writeFileSync|execSync)\(/.test(line)) {
          qualityIssues.push({
            type: 'sync_io_hotpath',
            filePath: fact.filePath,
            line: idx + 1,
            description: `Synchronous I/O function \`${line.trim().match(/(readFileSync|writeFileSync|execSync)/)?.[1]}\` executed inside loop/hotpath.`,
            severity: 'warning'
          });
        }
        if (line.includes('}')) insideLoop = false;
      });

      // Extract Function Definitions & Called Symbols
      const funcDefRegex = /(?:function\s+([a-zA-Z0-9_]+)|const\s+([a-zA-Z0-9_]+)\s*=\s*\(|async\s+function\s+([a-zA-Z0-9_]+))/g;
      let match;
      while ((match = funcDefRegex.exec(content)) !== null) {
        const funcName = match[1] || match[2] || match[3];
        if (funcName) {
          const key = `${path.relative(repoPath, fact.filePath)}:${funcName}`;
          nodes[key] = {
            name: funcName,
            filePath: fact.filePath,
            line: content.substring(0, match.index).split('\n').length,
            calls: []
          };
        }
      }

      // Check High Function Complexity
      if (fact.avgFuncLength > 80) {
        qualityIssues.push({
          type: 'high_complexity',
          filePath: fact.filePath,
          description: `Average function length is high (${fact.avgFuncLength} lines per function). Consider refactoring.`,
          severity: 'info'
        });
      }
    });

    // Detect Circular Dependencies between files
    Object.keys(importsMap).forEach(fileA => {
      const depsA = importsMap[fileA];
      depsA.forEach(dep => {
        const resolvedDep = Object.keys(importsMap).find(f => f.includes(dep));
        if (resolvedDep && importsMap[resolvedDep]) {
          const depsB = importsMap[resolvedDep];
          if (depsB.some(d => fileA.includes(d))) {
            qualityIssues.push({
              type: 'circular_dependency',
              filePath: fileA,
              description: `Circular import dependency detected between \`${path.basename(fileA)}\` and \`${path.basename(resolvedDep)}\`.`,
              severity: 'error'
            });
          }
        }
      });
    });

    return { nodes, importsMap, qualityIssues };
  }
}
