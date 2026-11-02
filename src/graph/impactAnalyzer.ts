import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { ImportResolver } from './importResolver.js';
import { AffectedTest, TestCommand, TestImpactAnalyzer } from './testImpact.js';

export interface ImpactAnalysisResult {
  target: string;
  directDependents: string[];
  transitiveDependents: string[];
  affectedRoutes: string[];
  breakingRiskWarning: string[];
  // Tests to run after the change, with a command per detected runner
  tests: { files: AffectedTest[]; commands: TestCommand[]; totalTests: number };
}

export class ImpactAnalyzer {
  public static analyzeImpact(repoPath: string, targetFileOrSymbol: string): ImpactAnalysisResult {
    const facts = ASTExtractor.scanDirectory(repoPath);

    const directDependents: Set<string> = new Set();
    const transitiveDependents: Set<string> = new Set();
    const affectedRoutes: Set<string> = new Set();
    const breakingRiskWarning: string[] = [];

    const rawBasename = path.basename(targetFileOrSymbol);
    const targetSymbolName = rawBasename.split('.')[0].toLowerCase();
    const targetNormalized = targetFileOrSymbol.toLowerCase().replace(/\\/g, '/');
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');

    // Resolve the target to indexed files: an exact/suffix file path, otherwise every file declaring the symbol
    const resolver = ImportResolver.forFacts(repoPath, facts);
    const targetFile = resolver.findFile(targetFileOrSymbol);
    const targetFiles = new Set<string>(
      targetFile ? [targetFile] : facts.filter(f => (f.symbols || []).includes(targetFileOrSymbol)).map(f => f.filePath)
    );
    const importers = ImportResolver.invertGraph(ImportResolver.buildImportGraph(repoPath, facts));

    // 1. Identify Direct Dependents (files whose resolved imports include the target)
    targetFiles.forEach(t => {
      (importers[t] || []).forEach(f => {
        if (!targetFiles.has(f)) directDependents.add(toRel(f));
      });
    });

    // 2. Identify Transitive Dependents (reverse import graph BFS from the direct dependents)
    const visited = new Set<string>(targetFiles);
    const queue: string[] = [];
    targetFiles.forEach(t => (importers[t] || []).forEach(f => {
      if (!visited.has(f)) { visited.add(f); queue.push(f); }
    }));
    while (queue.length > 0) {
      const current = queue.shift()!;
      (importers[current] || []).forEach(f => {
        if (visited.has(f)) return;
        visited.add(f);
        queue.push(f);
        transitiveDependents.add(toRel(f));
      });
    }

    if (targetFiles.size === 0) {
      breakingRiskWarning.push(`\`${targetFileOrSymbol}\` did not match an indexed file or declared symbol; only text references were scanned.`);
    }

    // 3. Scan for Route / Symbol Usage References across codebase
    facts.forEach(fact => {
      const content = ASTExtractor.readSourceFile(fact.filePath);
      if (content === null) return;

      if (content.toLowerCase().includes(targetSymbolName)) {
        const relPath = path.relative(repoPath, fact.filePath).replace(/\\/g, '/');
        if (!directDependents.has(relPath) && !targetFiles.has(fact.filePath) && relPath.toLowerCase() !== targetNormalized) {
          affectedRoutes.add(relPath);
        }
      }
    });

    // 4. Generate Breaking Risk Warnings
    if (directDependents.size > 0) {
      breakingRiskWarning.push(
        `Modifying \`${targetSymbolName}\` directly impacts ${directDependents.size} file(s): [${Array.from(directDependents).join(', ')}].`
      );
    }

    if (transitiveDependents.size > 0) {
      breakingRiskWarning.push(
        `Transitive downstream impact detected in ${transitiveDependents.size} additional file(s): [${Array.from(transitiveDependents).join(', ')}].`
      );
    }

    if (affectedRoutes.size > 0) {
      breakingRiskWarning.push(
        `Found ${affectedRoutes.size} file(s) referencing symbol \`${targetSymbolName}\`. Verify route/signature compatibility.`
      );
    }

    if (directDependents.size === 0 && transitiveDependents.size === 0 && affectedRoutes.size === 0) {
      breakingRiskWarning.push(`No direct import dependencies found for \`${targetSymbolName}\`. Changes appear isolated.`);
    }

    const testImpact = TestImpactAnalyzer.forTargets(repoPath, [targetFileOrSymbol]);
    return {
      target: targetFileOrSymbol,
      directDependents: Array.from(directDependents),
      transitiveDependents: Array.from(transitiveDependents),
      affectedRoutes: Array.from(affectedRoutes),
      breakingRiskWarning,
      tests: { files: testImpact.tests, commands: testImpact.commands, totalTests: testImpact.totalTests }
    };
  }
}
