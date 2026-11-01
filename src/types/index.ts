export interface ASTFact {
  filePath: string;
  language: string;
  constantsPlacement: 'top' | 'inline' | 'mixed';
  // UPPER_CASE constant declarations in the first 30 lines vs later
  constantCounts?: { top: number; inline: number };
  exportStyle: 'named' | 'default' | 'mixed';
  exportCounts?: { named: number; default: number };
  hasTypeAnnotations: boolean;
  typeCastingCount: number;
  importedModules: string[];
  funcCount: number;
  avgFuncLength: number;
  symbols?: string[];
}

export interface NamingStat {
  // camelCase | PascalCase | snake_case | UPPER_SNAKE_CASE | kebab-case
  style: string;
  // Share of informative (multi-word) names using that style, 0-1
  share: number;
  sample: number;
}

export interface NamingConventions {
  functions?: NamingStat;
  types?: NamingStat;
  constants?: NamingStat;
  components?: NamingStat;
  files?: NamingStat;
}

export interface CodebaseConvention {
  codebaseName: string;
  version: string;
  lastUpdated: string;
  // Role counts with example paths and file counts per top-level directory
  architecture?: {
    roles: Record<string, { count: number; examples: string[] }>;
    directories: Record<string, number>;
  };
  techDebtCount?: number;
  // How each learned value was derived, e.g. "structural.exportStyle": "named-only in 31 of 34 files with exports"
  evidence?: Record<string, string>;
  rules: {
    structural: {
      constantsPlacement: string;
      exportStyle: string;
      typeAnnotationRequirement: boolean;
      namingConvention: string;
      naming?: NamingConventions;
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
      // 'default' rules ship with the tool; 'learned' rules were derived from this codebase
      source?: 'learned' | 'default';
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
