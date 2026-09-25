import * as fs from 'fs';
import * as path from 'path';
import { ASTFact } from '../types/index.js';

export interface TechDebtItem {
  filePath: string;
  line: number;
  type: 'TODO' | 'FIXME' | 'HACK' | 'DEPRECATED';
  comment: string;
}

export class DocstringMiner {
  public static mineTechDebtAndDocs(repoPath: string, facts: ASTFact[]): TechDebtItem[] {
    const debtItems: TechDebtItem[] = [];

    facts.forEach(fact => {
      if (!fs.existsSync(fact.filePath)) return;
      let content = '';
      try {
        content = fs.readFileSync(fact.filePath, 'utf8');
      } catch {
        return;
      }

      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (/\/\/\s*(TODO|FIXME|HACK|DEPRECATED):?/i.test(trimmed) || /#\s*(TODO|FIXME|HACK|DEPRECATED):?/i.test(trimmed)) {
          const match = trimmed.match(/(TODO|FIXME|HACK|DEPRECATED)[:\s]*(.*)/i);
          if (match) {
            debtItems.push({
              filePath: path.relative(repoPath, fact.filePath),
              line: idx + 1,
              type: match[1].toUpperCase() as TechDebtItem['type'],
              comment: match[2] || trimmed
            });
          }
        }
      });
    });

    const outPath = path.join(repoPath, '.codebase', 'tech_debt.json');
    fs.writeFileSync(outPath, JSON.stringify(debtItems, null, 2), 'utf8');

    return debtItems;
  }
}
