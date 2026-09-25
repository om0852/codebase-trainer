import * as fs from 'fs';

export interface FixResult {
  filePath: string;
  fixedCount: number;
  changesDescription: string[];
}

export class AutoFixer {
  public static fixFile(filePath: string): FixResult {
    if (!fs.existsSync(filePath)) {
      return { filePath, fixedCount: 0, changesDescription: ['File does not exist'] };
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let fixedCount = 0;
    const changesDescription: string[] = [];

    // Fix explicit `: any` -> `: unknown` or `: Record<string, unknown>`
    if (content.includes(': any')) {
      const originalAnyMatches = (content.match(/:\s*any/g) || []).length;
      content = content.replace(/:\s*any/g, ': unknown');
      fixedCount += originalAnyMatches;
      changesDescription.push(`Replaced ${originalAnyMatches} instance(s) of explicit \`: any\` with \`: unknown\`.`);
    }

    // Fix legacy var -> const
    if (/\bvar\s+[a-zA-Z0-9_]+\s*=/.test(content)) {
      const varMatches = (content.match(/\bvar\s+/g) || []).length;
      content = content.replace(/\bvar\s+/g, 'const ');
      fixedCount += varMatches;
      changesDescription.push(`Replaced ${varMatches} instance(s) of legacy \`var\` with \`const\`.`);
    }

    if (fixedCount > 0) {
      fs.writeFileSync(filePath, content, 'utf8');
    }

    return { filePath, fixedCount, changesDescription };
  }
}
