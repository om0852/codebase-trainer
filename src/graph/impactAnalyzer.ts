import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';

export interface ImpactAnalysisResult {
  target: string;
  directDependents: string[];
  transitiveDependents: string[];
  affectedRoutes: string[];
  breakingRiskWarning: string[];
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

    // 1. Identify Direct Dependents (files that import/require target)
    facts.forEach(fact => {
      const factRelPath = path.relative(repoPath, fact.filePath).replace(/\\/g, '/');
      if (factRelPath.toLowerCase() === targetNormalized) return;

      const imports = fact.importedModules;
      const isDirectlyImported = imports.some(imp => {
        const impLower = imp.toLowerCase();
        return impLower.includes(targetSymbolName) || targetNormalized.includes(impLower);
      });

      if (isDirectlyImported) {
        directDependents.add(factRelPath);
      }
    });

    // 2. Identify Transitive Dependents
    let addedNew = true;
    const currentSet = new Set(directDependents);

    while (addedNew) {
      addedNew = false;
      facts.forEach(fact => {
        const factRelPath = path.relative(repoPath, fact.filePath).replace(/\\/g, '/');
        if (currentSet.has(factRelPath) || directDependents.has(factRelPath)) return;

        const imports = fact.importedModules;
        const importsDependent = imports.some(imp =>
          Array.from(currentSet).some(dep => dep.toLowerCase().includes(imp.toLowerCase()))
        );

        if (importsDependent) {
          transitiveDependents.add(factRelPath);
          currentSet.add(factRelPath);
          addedNew = true;
        }
      });
    }

    // 3. Scan for Route / Symbol Usage References across codebase
    facts.forEach(fact => {
      if (!fs.existsSync(fact.filePath)) return;
      let content = '';
      try {
        content = fs.readFileSync(fact.filePath, 'utf8');
      } catch {
        return;
      }

      if (content.toLowerCase().includes(targetSymbolName)) {
        const relPath = path.relative(repoPath, fact.filePath).replace(/\\/g, '/');
        if (!directDependents.has(relPath) && relPath.toLowerCase() !== targetNormalized) {
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

    return {
      target: targetFileOrSymbol,
      directDependents: Array.from(directDependents),
      transitiveDependents: Array.from(transitiveDependents),
      affectedRoutes: Array.from(affectedRoutes),
      breakingRiskWarning
    };
  }
}
