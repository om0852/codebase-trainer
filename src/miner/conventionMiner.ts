import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ASTFact, CodebaseConvention, NamingConventions, NamingStat } from '../types/index.js';
import { GitMiner, GitFact } from '../git/gitMiner.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';
import { DocstringMiner } from './docstringMiner.js';
import { ASTExtractor } from '../extractors/astExtractor.js';

// Below this many informative names a naming style is reported as not inferred
const MIN_NAMING_SAMPLE = 5;
const CODE_LANGUAGES = new Set(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'cpp', 'php']);
const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/PULL_REQUEST_TEMPLATE/pull_request_template.md',
  'docs/pull_request_template.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md'
];
const NOT_FUNCTION_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor', 'super', 'require']);

export class ConventionMiner {
  public static generateConventions(repoPath: string, facts: ASTFact[]): CodebaseConvention {
    const repoName = path.basename(path.resolve(repoPath));
    const gitFact: GitFact = GitMiner.extractGitFacts(repoPath);
    const techDebt = DocstringMiner.mineTechDebtAndDocs(repoPath, facts);
    const relOf = (f: ASTFact) => path.relative(repoPath, f.filePath).replace(/\\/g, '/');
    const codeFacts = facts.filter(f => CODE_LANGUAGES.has(f.language));
    const evidence: Record<string, string> = {};

    const exportStyle = this.measureExportStyle(repoPath, facts);
    evidence['structural.exportStyle'] = exportStyle.evidence;

    const constants = this.measureConstantsPlacement(codeFacts);
    evidence['structural.constantsPlacement'] = constants.evidence;

    const typing = this.measureTyping(codeFacts);
    evidence['structural.typeAnnotationRequirement'] = typing.evidence;

    const naming = this.mineNaming(repoPath, codeFacts);
    const namingSummary = this.describeNaming(naming);
    evidence['structural.namingConvention'] = namingSummary;

    const branchNaming = this.describeBranches(gitFact);
    evidence['git.branchNaming'] = `${gitFact.branchNames.length} branch name(s) examined`;

    const prTemplate = this.readPrTemplateSections(repoPath);
    evidence['git.prTemplateSections'] = prTemplate.source;

    const docs = this.measureDocComments(codeFacts);
    evidence['documentation.requireDocstrings'] = docs.evidence;

    const customRules: CodebaseConvention['rules']['customRules'] = [];
    if (typing.required && codeFacts.some(f => f.language === 'typescript')) {
      customRules.push({ id: 'no-explicit-any', description: 'Avoid explicit `any` where strict types are used', severity: 'warning', source: 'default' });
    }
    if (constants.placement === 'top') {
      customRules.push({ id: 'top-level-constants', description: 'Define configuration constants near the top of the file', severity: 'info', source: 'default' });
    }

    return {
      codebaseName: repoName,
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      architecture: IntentClassifier.summarizeArchitecture(repoPath, facts),
      techDebtCount: techDebt.length,
      evidence,
      rules: {
        structural: {
          constantsPlacement: constants.placement,
          exportStyle: exportStyle.style,
          typeAnnotationRequirement: typing.required,
          namingConvention: namingSummary,
          naming
        },
        git: {
          commitFormat: gitFact.commitFormatPattern,
          branchNaming,
          prTemplateSections: prTemplate.sections
        },
        documentation: {
          requireDocstrings: docs.required,
          commentStyle: docs.style
        },
        customRules
      }
    };
  }

  /**
   * Export style across JS/TS files that export something, excluding framework files that must use
   * default exports (Next.js pages, config files). Files with no exports carry no signal and are skipped.
   */
  public static measureExportStyle(repoPath: string, facts: ASTFact[]): { style: string; evidence: string } {
    let namedOnly = 0;
    let defaultOnly = 0;
    let both = 0;
    facts.forEach(f => {
      if (!['typescript', 'javascript'].includes(f.language) || !f.exportCounts) return;
      if (IntentClassifier.requiresDefaultExport(path.relative(repoPath, f.filePath))) return;
      const { named, default: def } = f.exportCounts;
      if (named > 0 && def > 0) both++;
      else if (named > 0) namedOnly++;
      else if (def > 0) defaultOnly++;
    });
    const total = namedOnly + defaultOnly + both;
    if (total === 0) return { style: 'unknown', evidence: 'No JS/TS files with exports (framework files excluded)' };

    let style = 'mixed';
    if (namedOnly / total >= 0.6) style = 'named';
    else if (defaultOnly / total >= 0.6) style = 'default';
    return { style, evidence: `${namedOnly} named-only, ${defaultOnly} default-only, ${both} both, of ${total} JS/TS files with exports (framework files excluded)` };
  }

  private static measureConstantsPlacement(facts: ASTFact[]): { placement: string; evidence: string } {
    let topOnly = 0;
    let withInline = 0;
    facts.forEach(f => {
      if (!f.constantCounts || f.constantCounts.top + f.constantCounts.inline === 0) return;
      if (f.constantCounts.inline === 0) topOnly++;
      else withInline++;
    });
    const total = topOnly + withInline;
    if (total === 0) return { placement: 'unknown', evidence: 'No UPPER_CASE constants found' };
    const placement = topOnly / total >= 0.7 ? 'top' : withInline / total >= 0.7 ? 'inline' : 'mixed';
    return { placement, evidence: `UPPER_CASE constants only in the first 30 lines in ${topOnly} of ${total} files that declare them` };
  }

  private static measureTyping(facts: ASTFact[]): { required: boolean; evidence: string } {
    const jsTs = facts.filter(f => ['typescript', 'javascript'].includes(f.language));
    if (jsTs.length > 0) {
      const ts = jsTs.filter(f => f.language === 'typescript').length;
      return { required: ts / jsTs.length >= 0.5, evidence: `${ts} of ${jsTs.length} JS/TS files are TypeScript` };
    }
    const python = facts.filter(f => f.language === 'python');
    if (python.length > 0) {
      let defs = 0;
      let annotated = 0;
      python.forEach(f => {
        for (const m of this.read(f.filePath).matchAll(/^\s*(?:async\s+)?def\s+\w+\s*\(([^)]*)\)\s*(->)?/gm)) {
          defs++;
          if (m[2] || /:\s*\w/.test(m[1])) annotated++;
        }
      });
      return { required: defs > 0 && annotated / defs >= 0.5, evidence: `${annotated} of ${defs} Python functions have type hints` };
    }
    const typed = facts.filter(f => ['go', 'rust', 'java', 'cpp'].includes(f.language)).length;
    return { required: typed > 0, evidence: typed > 0 ? 'Statically typed language' : 'No code files' };
  }

  /**
   * Naming styles of declared functions, types, module-level constants, React components and file names.
   * Only multi-word names count, since `load` or `user` fit camelCase and snake_case alike.
   */
  public static mineNaming(repoPath: string, facts: ASTFact[]): NamingConventions {
    const buckets: Record<keyof NamingConventions, string[]> = { functions: [], types: [], constants: [], components: [], files: [] };

    facts.forEach(f => {
      const content = this.read(f.filePath);
      const isJsx = /\.(jsx|tsx)$/i.test(f.filePath);

      for (const m of content.matchAll(/\b(?:class|interface|enum|struct|trait)\s+([A-Za-z_$][\w$]*)|\btype\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:=|struct|interface)/g)) {
        buckets.types.push(m[1] || m[2]);
      }
      const functionNames: string[] = [];
      for (const m of content.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>|\bdef\s+([A-Za-z_]\w*)|\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|\bfn\s+([A-Za-z_]\w*)/g)) {
        functionNames.push(m[1] || m[2] || m[3] || m[4] || m[5]);
      }
      for (const m of content.matchAll(/^\s+(?:(?:public|private|protected|static|async|override|readonly)\s+)+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/gm)) {
        functionNames.push(m[1]);
      }
      functionNames.filter(n => !NOT_FUNCTION_NAMES.has(n) && !/^__\w+__$/.test(n)).forEach(name => {
        // In JSX files a PascalCase function is a component, which has its own convention
        if (isJsx && /^[A-Z]/.test(name)) buckets.components.push(name);
        else buckets.functions.push(name);
      });

      // Module-level constants holding literal values (strings, numbers, booleans, arrays, frozen objects)
      for (const m of content.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:['"`\d[]|true\b|false\b|Object\.freeze)/gm)) {
        buckets.constants.push(m[1]);
      }
      if (f.language === 'python') {
        for (const m of content.matchAll(/^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:['"\d[({]|True\b|False\b)/gm)) buckets.constants.push(m[1]);
      }

      const rel = path.relative(repoPath, f.filePath).replace(/\\/g, '/');
      const base = path.basename(rel).split('.')[0];
      if (base && !['index', 'main', 'page', 'layout', 'route', 'mod', 'lib', '__init__', 'setup', 'conftest'].includes(base)) {
        buckets.files.push(base);
      }
    });

    const result: NamingConventions = {};
    (Object.keys(buckets) as Array<keyof NamingConventions>).forEach(kind => {
      const stat = this.dominantStyle(buckets[kind], kind === 'files');
      if (stat) result[kind] = stat;
    });
    return result;
  }

  private static dominantStyle(names: string[], isFileName: boolean): NamingStat | undefined {
    const counts = new Map<string, number>();
    let sample = 0;
    names.forEach(raw => {
      const style = this.classifyName(raw.replace(/^[_$]+/, ''), isFileName);
      if (!style) return;
      sample++;
      counts.set(style, (counts.get(style) || 0) + 1);
    });
    if (sample < MIN_NAMING_SAMPLE) return undefined;
    const [style, count] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    return { style, share: Number((count / sample).toFixed(2)), sample };
  }

  // Style of a multi-word identifier; single words are ambiguous and return null
  private static classifyName(name: string, isFileName: boolean): string | null {
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return 'UPPER_SNAKE_CASE';
    if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return 'snake_case';
    if (isFileName && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name)) return 'kebab-case';
    if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(name)) return 'PascalCase';
    if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(name)) return 'camelCase';
    return null;
  }

  private static describeNaming(naming: NamingConventions): string {
    const labels: Record<keyof NamingConventions, string> = {
      functions: 'functions', types: 'classes/types', constants: 'module constants', components: 'components', files: 'file names'
    };
    const parts = (Object.keys(labels) as Array<keyof NamingConventions>)
      .filter(k => naming[k])
      .map(k => `${labels[k]} ${naming[k]!.style} (${Math.round(naming[k]!.share * 100)}% of ${naming[k]!.sample})`);
    return parts.length > 0 ? parts.join(', ') : 'Not enough multi-word names to infer a naming convention';
  }

  private static describeBranches(git: GitFact): string {
    const defaults = new Set(['main', 'master', 'develop', 'dev', 'trunk', git.activeBranch]);
    const others = git.branchNames.filter(b => !defaults.has(b));
    if (others.length === 0) return git.branchNames.length > 0 ? `Only default branches (${Array.from(new Set(git.branchNames)).slice(0, 3).join(', ')})` : 'Unknown';

    const prefixes = new Map<string, number>();
    others.forEach(b => {
      if (b.includes('/')) {
        const prefix = b.split('/')[0];
        prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
      }
    });
    const prefixed = Array.from(prefixes.values()).reduce((a, b) => a + b, 0);
    if (prefixed / others.length < 0.5) return `No prefix convention (${prefixed} of ${others.length} branches use a prefix/)`;
    const top = Array.from(prefixes.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => `${p}/ ${n}`);
    return `prefix/name (${top.join(', ')}; ${prefixed} of ${others.length} branches)`;
  }

  private static readPrTemplateSections(repoPath: string): { sections: string[]; source: string } {
    for (const rel of PR_TEMPLATE_PATHS) {
      const content = this.read(path.join(repoPath, rel));
      if (!content) continue;
      const sections = Array.from(content.matchAll(/^#{1,3}\s+(.+?)\s*#*\s*$/gm)).map(m => m[1]);
      return { sections, source: `Headings in ${rel}` };
    }
    return { sections: [], source: 'No pull request template found' };
  }

  /**
   * Share of exported JS/TS declarations preceded by a JSDoc block, and of Python functions with a docstring.
   */
  private static measureDocComments(facts: ASTFact[]): { required: boolean; style: string; evidence: string } {
    const js = { declarations: 0, documented: 0 };
    const py = { declarations: 0, documented: 0 };
    facts.forEach(f => {
      const lines = this.read(f.filePath).split(/\r?\n/);
      if (['typescript', 'javascript'].includes(f.language)) {
        lines.forEach((line, idx) => {
          if (!/^\s*export\s+(?:default\s+)?(?:(?:declare|abstract|async)\s+)*(?:function|class|const\s+\w+\s*=\s*(?:async\s*)?\()/.test(line)) return;
          js.declarations++;
          let prev = idx - 1;
          while (prev >= 0 && (lines[prev].trim() === '' || /^\s*@/.test(lines[prev]))) prev--;
          if (prev >= 0 && /\*\/\s*$/.test(lines[prev])) js.documented++;
        });
      } else if (f.language === 'python') {
        lines.forEach((line, idx) => {
          if (!/^\s*(?:async\s+)?def\s+[a-zA-Z]\w*\s*\(/.test(line)) return;
          py.declarations++;
          const next = lines.slice(idx + 1).find(l => l.trim() !== '');
          if (next && /^\s*[rRbBuU]?("""|''')/.test(next)) py.documented++;
        });
      }
    });

    const declarations = js.declarations + py.declarations;
    if (declarations === 0) return { required: false, style: 'No exported declarations found', evidence: 'No exported functions or classes' };
    const pct = (s: { declarations: number; documented: number }) => Math.round((s.documented / s.declarations) * 100);
    const parts: string[] = [];
    const evidence: string[] = [];
    if (js.declarations > 0) {
      parts.push(`JSDoc on ${pct(js)}% of exported JS/TS declarations`);
      evidence.push(`${js.documented} of ${js.declarations} exported JS/TS functions/classes have JSDoc`);
    }
    if (py.declarations > 0) {
      parts.push(`docstrings on ${pct(py)}% of Python functions`);
      evidence.push(`${py.documented} of ${py.declarations} public Python functions have docstrings`);
    }
    return {
      required: declarations >= MIN_NAMING_SAMPLE && (js.documented + py.documented) / declarations >= 0.6,
      style: parts.join('; '),
      evidence: evidence.join('; ')
    };
  }

  private static read(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  public static saveConventions(repoPath: string, conventions: CodebaseConvention): string {
    const codebaseDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(codebaseDir)) {
      fs.mkdirSync(codebaseDir, { recursive: true });
    }

    const filePath = path.join(codebaseDir, 'conventions.yaml');
    const yamlStr = yaml.dump(conventions, { indent: 2 });
    fs.writeFileSync(filePath, yamlStr, 'utf8');
    return filePath;
  }

  /**
   * Saved conventions, regenerated when missing or written by a version that did not record evidence
   * (those carry hard-coded naming/PR rules and a per-file role map).
   */
  public static loadOrGenerate(repoPath: string, facts?: ASTFact[]): CodebaseConvention {
    const saved = this.loadConventions(repoPath);
    if (saved && saved.evidence) return saved;
    const conventions = this.generateConventions(repoPath, facts || ASTExtractor.scanDirectory(repoPath));
    this.saveConventions(repoPath, conventions);
    return conventions;
  }

  public static loadConventions(repoPath: string): CodebaseConvention | null {
    const filePath = path.join(repoPath, '.codebase', 'conventions.yaml');
    if (!fs.existsSync(filePath)) return null;
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return yaml.load(fileContent) as CodebaseConvention;
  }
}
