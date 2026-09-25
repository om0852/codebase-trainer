import * as fs from 'fs';
import * as path from 'path';
import { ConventionMiner } from '../miner/conventionMiner.js';
import { ImpactAnalyzer } from '../graph/impactAnalyzer.js';
import { GitMiner } from '../git/gitMiner.js';

export interface PRReviewReport {
  repoName: string;
  passed: boolean;
  summaryMarkdown: string;
  violationsCount: number;
}

export class PRReviewer {
  public static reviewPR(repoPath: string, diffContent?: string): PRReviewReport {
    const conventions = ConventionMiner.loadConventions(repoPath);
    const diff = diffContent || GitMiner.getUncommittedDiff(repoPath);

    const violations: Array<{ rule: string; desc: string; severity: 'error' | 'warning' }> = [];

    if (conventions) {
      if (conventions.rules.structural.typeAnnotationRequirement && diff.includes(': any')) {
        violations.push({
          rule: 'no-explicit-any',
          desc: 'Explicit `: any` casting detected. Use `unknown` or typed interfaces.',
          severity: 'warning'
        });
      }

      if (diff.includes('console.log(')) {
        violations.push({
          rule: 'no-console-log',
          desc: 'Leftover `console.log()` statement detected. Prefer structured logger.',
          severity: 'warning'
        });
      }

      if (diff.includes('execSync(') || diff.includes('readFileSync(')) {
        violations.push({
          rule: 'no-sync-io-in-pr',
          desc: 'Synchronous I/O operation detected in PR diff.',
          severity: 'error'
        });
      }
    }

    const passed = violations.filter(v => v.severity === 'error').length === 0;

    const summaryMarkdown = `## 🤖 Codebase Trainer Automated PR Review Report

**Repository**: \`${conventions?.codebaseName || path.basename(repoPath)}\`
**Status**: ${passed ? '✅ APPROVED' : '🚨 CHANGES REQUESTED'}

### 📋 Policy & Convention Checks
${violations.length === 0 ? '✨ All structural conventions and security policies passed!' : violations.map(v => `- [${v.severity.toUpperCase()}] **${v.rule}**: ${v.desc}`).join('\n')}

---
*Generated automatically by Codebase Trainer Enterprise Engine.*
`;

    const reportPath = path.join(repoPath, '.codebase', 'pr_review.md');
    fs.writeFileSync(reportPath, summaryMarkdown, 'utf8');

    return {
      repoName: conventions?.codebaseName || path.basename(repoPath),
      passed,
      summaryMarkdown,
      violationsCount: violations.length
    };
  }
}
