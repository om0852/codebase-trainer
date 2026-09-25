import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ASTFact, CodebaseConvention } from '../types/index.js';
import { GitMiner, GitFact } from '../git/gitMiner.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';
import { DocstringMiner } from './docstringMiner.js';

export class ConventionMiner {
  public static generateConventions(repoPath: string, facts: ASTFact[]): CodebaseConvention {
    const repoName = path.basename(path.resolve(repoPath));
    const gitFact: GitFact = GitMiner.extractGitFacts(repoPath);
    const architecturalMap = IntentClassifier.classifyCodebase(facts);
    const techDebt = DocstringMiner.mineTechDebtAndDocs(repoPath, facts);

    // Aggregate facts
    let topConstCount = 0;
    let namedExportCount = 0;
    let typeAnnotationCount = 0;

    facts.forEach(f => {
      if (f.constantsPlacement === 'top') topConstCount++;
      if (f.exportStyle === 'named') namedExportCount++;
      if (f.hasTypeAnnotations) typeAnnotationCount++;
    });

    const total = facts.length || 1;
    const constantsPlacement = topConstCount / total >= 0.5 ? 'top' : 'inline';
    const exportStyle = namedExportCount / total >= 0.5 ? 'named' : 'default';
    const requireTypeAnnotations = typeAnnotationCount / total >= 0.5;

    const conventions: CodebaseConvention & { architecturalMap?: Record<string, string>; techDebtCount?: number } = {
      codebaseName: repoName,
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      architecturalMap,
      techDebtCount: techDebt.length,
      rules: {
        structural: {
          constantsPlacement,
          exportStyle,
          typeAnnotationRequirement: requireTypeAnnotations,
          namingConvention: 'camelCase variables, PascalCase classes/interfaces'
        },
        git: {
          commitFormat: gitFact.commitFormatPattern,
          branchNaming: `active: ${gitFact.activeBranch}`,
          prTemplateSections: ['Summary', 'Testing', 'Checklist']
        },
        documentation: {
          requireDocstrings: false,
          commentStyle: 'Use inline JSDoc comments for exported functions'
        },
        customRules: [
          {
            id: 'no-explicit-any',
            description: 'Avoid using explicit any type casting when strict types are defined',
            severity: 'warning'
          },
          {
            id: 'top-level-constants',
            description: 'Define configuration constants at top of file',
            severity: 'info'
          }
        ]
      }
    };

    return conventions as CodebaseConvention;
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

  public static loadConventions(repoPath: string): CodebaseConvention | null {
    const filePath = path.join(repoPath, '.codebase', 'conventions.yaml');
    if (!fs.existsSync(filePath)) return null;
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return yaml.load(fileContent) as CodebaseConvention;
  }
}
