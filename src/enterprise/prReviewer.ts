import * as fs from 'fs';
import * as path from 'path';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { DiffChecker, DiffCheckReport } from '../review/diffChecker.js';

export interface PRReviewReport {
  repoName: string;
  passed: boolean;
  summaryMarkdown: string;
  violationsCount: number;
  check: DiffCheckReport;
}

export class PRReviewer {
  /**
   * Markdown review of a diff (by default the working tree against HEAD, or against `base`).
   */
  public static reviewPR(repoPath: string, diffContent?: string, base?: string): PRReviewReport {
    const conventions = ConventionMiner.loadConventions(repoPath);
    const repoName = conventions?.codebaseName || path.basename(repoPath);
    const check = DiffChecker.check(repoPath, { diff: diffContent, base });

    const status = check.status === 'invalid-input'
      ? '⚠️ COULD NOT REVIEW'
      : check.status === 'no-changes'
        ? 'ℹ️ NO CHANGES'
        : check.passed ? '✅ NO BLOCKING FINDINGS' : '🚨 CHANGES REQUESTED';

    const findings = check.findings.length === 0
      ? (check.status === 'invalid-input' ? `- ${check.error}` : '- None of the checks below matched.')
      : check.findings.map(f => `- [${f.severity.toUpperCase()}] \`${f.filePath}${f.line ? `:${f.line}` : ''}\` **${f.ruleId}**: ${f.message}`).join('\n');

    const summaryMarkdown = `## 🤖 Codebase Trainer Automated PR Review Report

**Repository**: \`${repoName}\`
**Status**: ${status}
**Diff**: ${check.source} (${check.filesChecked.length} file(s), ${check.addedLines} added line(s))

### Findings
${findings}

### Checks run
${check.checksRun.map(c => `- **${c.id}**: ${c.description}`).join('\n')}

### Not checked (needs human review)
${check.notCovered.map(n => `- ${n}`).join('\n')}

---
*Generated automatically by Codebase Trainer.*
`;

    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'pr_review.md'), summaryMarkdown, 'utf8');

    return {
      repoName,
      passed: check.passed,
      summaryMarkdown,
      violationsCount: check.findings.length,
      check
    };
  }
}
