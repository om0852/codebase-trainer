export interface ASTFact {
  filePath: string;
  language: string;
  constantsPlacement: 'top' | 'inline' | 'mixed';
  exportStyle: 'named' | 'default' | 'mixed';
  hasTypeAnnotations: boolean;
  typeCastingCount: number;
  importedModules: string[];
  funcCount: number;
  avgFuncLength: number;
}

export interface CodebaseConvention {
  codebaseName: string;
  version: string;
  lastUpdated: string;
  rules: {
    structural: {
      constantsPlacement: string;
      exportStyle: string;
      typeAnnotationRequirement: boolean;
      namingConvention: string;
    };
    git: {
      commitFormat: string;
      branchNaming: string;
      prTemplateSections: string[];
    };
    documentation: {
      requireDocstrings: boolean;
      commentStyle: string;
    };
    customRules: Array<{
      id: string;
      description: string;
      severity: 'error' | 'warning' | 'info';
    }>;
  };
}

export interface ReviewResult {
  passed: boolean;
  violations: Array<{
    ruleId: string;
    filePath?: string;
    line?: number;
    message: string;
    severity: 'error' | 'warning' | 'info';
  }>;
}
