import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitFact {
  commitFormatPattern: string;
  recentCommitTypes: string[];
  activeBranch: string;
  uncommittedModifiedFiles: string[];
}

export class GitMiner {
  public static isGitRepo(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, '.git'));
  }

  public static extractGitFacts(repoPath: string): GitFact {
    if (!this.isGitRepo(repoPath)) {
      return {
        commitFormatPattern: 'Unknown (Not a git repository)',
        recentCommitTypes: [],
        activeBranch: 'main',
        uncommittedModifiedFiles: []
      };
    }

    try {
      // Get current active branch
      const activeBranch = execSync('git branch --show-current', { cwd: repoPath, encoding: 'utf8' }).trim();

      // Get recent 20 commit messages
      const logs = execSync('git log -n 20 --pretty=format:"%s"', { cwd: repoPath, encoding: 'utf8' })
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      const commitTypes = new Set<string>();
      const conventionalRegex = /^([a-z]+)(\([a-z0-9_\-]+\))?:/;

      logs.forEach(msg => {
        const match = msg.match(conventionalRegex);
        if (match && match[1]) {
          commitTypes.add(match[1]);
        }
      });

      const commitFormatPattern = commitTypes.size > 0
        ? `Conventional Commits (${Array.from(commitTypes).join(', ')})`
        : 'Freeform commit messages';

      // Get uncommitted changed files
      const statusOutput = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8' });
      const uncommittedModifiedFiles = statusOutput
        .split('\n')
        .map(line => line.trim().slice(3))
        .filter(Boolean);

      return {
        commitFormatPattern,
        recentCommitTypes: Array.from(commitTypes),
        activeBranch,
        uncommittedModifiedFiles
      };
    } catch {
      return {
        commitFormatPattern: 'Default commit style',
        recentCommitTypes: ['feat', 'fix', 'docs'],
        activeBranch: 'main',
        uncommittedModifiedFiles: []
      };
    }
  }

  public static getUncommittedDiff(repoPath: string): string {
    if (!this.isGitRepo(repoPath)) return '';
    try {
      return execSync('git diff HEAD', { cwd: repoPath, encoding: 'utf8' });
    } catch {
      return '';
    }
  }
}
