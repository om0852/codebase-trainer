import * as fs from 'fs';
import * as path from 'path';

export class GitHooksManager {
  public static installHooks(repoPath: string): { success: boolean; message: string } {
    const hooksDir = path.join(repoPath, '.git', 'hooks');
    if (!fs.existsSync(hooksDir)) {
      return { success: false, message: 'Not a git repository or .git/hooks directory not found.' };
    }

    const postCommitHookPath = path.join(hooksDir, 'post-commit');
    const hookScript = `#!/bin/sh
# Codebase Trainer post-commit hook
echo "🔄 Running incremental codebase-trainer re-scan..."
npx cb-trainer update
`;

    try {
      fs.writeFileSync(postCommitHookPath, hookScript, { encoding: 'utf8', mode: 0o755 });
      return { success: true, message: `Installed post-commit hook at ${postCommitHookPath}` };
    } catch (err: any) {
      return { success: false, message: `Failed to install git hook: ${err.message}` };
    }
  }

  public static uninstallHooks(repoPath: string): { success: boolean; message: string } {
    const postCommitHookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
    if (fs.existsSync(postCommitHookPath)) {
      try {
        fs.unlinkSync(postCommitHookPath);
        return { success: true, message: 'Uninstalled post-commit hook successfully.' };
      } catch (err: any) {
        return { success: false, message: `Failed to uninstall git hook: ${err.message}` };
      }
    }
    return { success: true, message: 'No git hooks were installed.' };
  }
}
