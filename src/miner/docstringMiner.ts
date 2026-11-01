import * as fs from 'fs';
import * as path from 'path';
import { ASTFact } from '../types/index.js';
import { ASTExtractor } from '../extractors/astExtractor.js';

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
      const content = ASTExtractor.readSourceFile(fact.filePath);
      if (content === null) return;

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

    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'tech_debt.json'), JSON.stringify(debtItems, null, 2), 'utf8');

    return debtItems;
  }
}
