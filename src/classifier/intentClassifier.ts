import * as path from 'path';
import { ASTFact } from '../types/index.js';

export type ArchitecturalRole =
  | 'controller_route'
  | 'data_model'
  | 'service_business_logic'
  | 'ui_component'
  | 'utility_helper'
  | 'test_spec'
  | 'configuration'
  | 'unknown';

export interface FileRoleFact {
  filePath: string;
  role: ArchitecturalRole;
  confidence: number;
}

export class IntentClassifier {
  public static classifyFile(fact: ASTFact): FileRoleFact {
    const lowerPath = fact.filePath.toLowerCase().replace(/\\/g, '/');
    const basename = path.basename(fact.filePath).toLowerCase();

    if (lowerPath.includes('test') || lowerPath.includes('spec') || basename.includes('.test.') || basename.includes('.spec.')) {
      return { filePath: fact.filePath, role: 'test_spec', confidence: 0.95 };
    }

    if (lowerPath.includes('route') || lowerPath.includes('controller') || lowerPath.includes('/api/')) {
      return { filePath: fact.filePath, role: 'controller_route', confidence: 0.90 };
    }

    if (lowerPath.includes('model') || lowerPath.includes('entity') || lowerPath.includes('schema') || lowerPath.includes('types')) {
      return { filePath: fact.filePath, role: 'data_model', confidence: 0.85 };
    }

    if (lowerPath.includes('component') || lowerPath.includes('/ui/') || ['.tsx', '.jsx'].some(ext => basename.endsWith(ext))) {
      return { filePath: fact.filePath, role: 'ui_component', confidence: 0.90 };
    }

    if (lowerPath.includes('service') || lowerPath.includes('manager') || lowerPath.includes('engine')) {
      return { filePath: fact.filePath, role: 'service_business_logic', confidence: 0.85 };
    }

    if (lowerPath.includes('util') || lowerPath.includes('helper') || lowerPath.includes('tool')) {
      return { filePath: fact.filePath, role: 'utility_helper', confidence: 0.80 };
    }

    if (basename.includes('config') || basename.includes('.json') || basename.includes('.yaml') || basename.includes('.env')) {
      return { filePath: fact.filePath, role: 'configuration', confidence: 0.90 };
    }

    return { filePath: fact.filePath, role: 'unknown', confidence: 0.50 };
  }

  public static classifyCodebase(facts: ASTFact[]): Record<string, string> {
    const map: Record<string, string> = {};
    facts.forEach(f => {
      const res = this.classifyFile(f);
      map[path.basename(f.filePath)] = res.role;
    });
    return map;
  }
}
