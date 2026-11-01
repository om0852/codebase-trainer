import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { ImportResolver } from './importResolver.js';
import { CallGraphAnalyzer } from './callGraph.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';
import { ASTFact } from '../types/index.js';

export interface ArchitectureModule {
  id: string;
  files: number;
}

export interface ModuleDependency {
  from: string;
  to: string;
  // Number of file-level imports from `from` into `to`
  imports: number;
}

export interface ArchitectureDiagram {
  mermaidDiagram: string;
  modules: ArchitectureModule[];
  dependencies: ModuleDependency[];
  // Groups of modules that import each other in a cycle
  moduleCycles: string[][];
  notes: string[];
}

const ROOT_MODULE = '(root)';
const MAX_MODULES = 40;
const CODE_LANGUAGES = new Set(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'cpp', 'php']);

/**
 * Module-level dependency diagram: files are grouped into modules (e.g. `src/graph`), and module A points
 * at module B when a file in A imports a file in B. Built from the resolved import graph, so every arrow
 * corresponds to at least one real import.
 */
export class ArchitectureDiagramBuilder {
  public static build(repoPath: string, facts: ASTFact[] = ASTExtractor.scanDirectory(repoPath)): ArchitectureDiagram {
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');
    const codeFacts = facts.filter(f => CODE_LANGUAGES.has(f.language) && !IntentClassifier.isTestFile(toRel(f.filePath)));
    const moduleOf = (file: string) => IntentClassifier.moduleOf(toRel(file)) || ROOT_MODULE;

    const fileCounts = new Map<string, number>();
    codeFacts.forEach(f => fileCounts.set(moduleOf(f.filePath), (fileCounts.get(moduleOf(f.filePath)) || 0) + 1));

    const edgeCounts = new Map<string, number>();
    const imports = ImportResolver.buildImportGraph(repoPath, codeFacts);
    Object.entries(imports).forEach(([from, targets]) => {
      const fromModule = moduleOf(from);
      targets.forEach(target => {
        const toModule = moduleOf(target);
        if (toModule === fromModule) return;
        const key = `${fromModule}\u0000${toModule}`;
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
      });
    });

    let dependencies: ModuleDependency[] = Array.from(edgeCounts.entries())
      .map(([key, count]) => {
        const [from, to] = key.split('\u0000');
        return { from, to, imports: count };
      })
      .sort((a, b) => b.imports - a.imports || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

    let modules: ArchitectureModule[] = Array.from(fileCounts.entries())
      .map(([id, files]) => ({ id, files }))
      .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id));

    const notes = ['Arrows are module-level summaries of resolved imports between code files (tests excluded); the label is the number of file imports.'];
    if (modules.length > MAX_MODULES) {
      // Keep the most connected modules so the diagram stays readable
      const degree = new Map<string, number>();
      dependencies.forEach(d => {
        degree.set(d.from, (degree.get(d.from) || 0) + d.imports);
        degree.set(d.to, (degree.get(d.to) || 0) + d.imports);
      });
      const keep = new Set(modules.map(m => m.id).sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0)).slice(0, MAX_MODULES));
      notes.push(`Showing the ${MAX_MODULES} most connected of ${modules.length} modules.`);
      modules = modules.filter(m => keep.has(m.id));
      dependencies = dependencies.filter(d => keep.has(d.from) && keep.has(d.to));
    }

    const moduleGraph: Record<string, string[]> = {};
    modules.forEach(m => { moduleGraph[m.id] = []; });
    dependencies.forEach(d => moduleGraph[d.from]?.push(d.to));
    const moduleCycles = CallGraphAnalyzer.findImportCycles(moduleGraph).map(cycle => cycle.sort());
    if (moduleCycles.length > 0) notes.push(`${moduleCycles.length} group(s) of modules import each other in a cycle (highlighted).`);

    return { mermaidDiagram: this.toMermaid(modules, dependencies, moduleCycles), modules, dependencies, moduleCycles, notes };
  }

  private static toMermaid(modules: ArchitectureModule[], dependencies: ModuleDependency[], cycles: string[][]): string {
    const nodeId = (id: string) => 'm_' + id.replace(/[^a-zA-Z0-9]/g, '_');
    const label = (id: string) => id.replace(/["<>]/g, '');
    const lines = ['graph LR'];
    modules.forEach(m => lines.push(`  ${nodeId(m.id)}["${label(m.id)} (${m.files})"]`));
    dependencies.forEach(d => lines.push(`  ${nodeId(d.from)} -->|${d.imports}| ${nodeId(d.to)}`));
    const inCycle = new Set(cycles.flat());
    if (inCycle.size > 0) {
      lines.push('  classDef cycle fill:#7f1d1d,stroke:#ef4444,color:#fee2e2');
      lines.push(`  class ${Array.from(inCycle).map(nodeId).join(',')} cycle`);
    }
    return lines.join('\n');
  }
}
