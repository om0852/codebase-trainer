import * as fs from 'fs';
import * as path from 'path';

/**
 * Silent change tracking for the long-running MCP server: a recursive file watch that records which paths changed,
 * so the file listing can patch those few entries instead of walking and statting the whole repo on every tool
 * call. When the watch cannot be trusted (no recursive watch on this platform, a watcher error, an event without
 * a file name) callers fall back to a full walk.
 */

interface WatchState {
  watcher: fs.FSWatcher;
  // Repo-relative paths changed since the last take, or 'all' when anything may have changed
  dirty: Set<string> | 'all';
  startedAt: number;
}

// On macOS the recursive watch starts a moment after fs.watch() returns; changes in that gap are never reported,
// so for this long after starting every check walks the repo
export const WATCH_WARMUP_MS = 2000;

// Generated state and VCS internals change constantly and are never indexed
const IGNORED_PREFIXES = ['.codebase/', '.git/', 'node_modules/', '.codebase-neural-cache/'];

export class RepoWatch {
  private static states = new Map<string, WatchState>();

  /** Starts watching; returns false when recursive watching is not available. */
  public static start(repoPath: string): boolean {
    const root = path.resolve(repoPath);
    if (this.states.has(root)) return true;
    try {
      const state: WatchState = { watcher: null as unknown as fs.FSWatcher, dirty: 'all', startedAt: Date.now() };
      // Watch the real path: macOS reports events against it (temp folders live under /var -> /private/var), and
      // file names relative to a symlinked path would not match the repo's files
      state.watcher = fs.watch(fs.realpathSync(root), { recursive: true, persistent: false }, (_event, filename) => {
        if (state.dirty === 'all') return;
        if (!filename) {
          state.dirty = 'all';
          return;
        }
        const rel = filename.toString().replace(/\\/g, '/');
        // A name that does not point inside the repo cannot be patched safely: walk everything next time
        if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) {
          state.dirty = 'all';
          return;
        }
        if (IGNORED_PREFIXES.some(p => rel === p.slice(0, -1) || rel.startsWith(p))) return;
        state.dirty.add(rel);
        // A burst of changes (branch switch, npm install, codegen) is cheaper as one walk
        if (state.dirty.size > 500) state.dirty = 'all';
      });
      state.watcher.on('error', () => this.stop(root));
      this.states.set(root, state);
      return true;
    } catch {
      return false;
    }
  }

  public static stop(repoPath: string): void {
    const root = path.resolve(repoPath);
    const state = this.states.get(root);
    if (!state) return;
    try {
      state.watcher.close();
    } catch {
      // Already closed
    }
    this.states.delete(root);
  }

  public static stopAll(): void {
    [...this.states.keys()].forEach(root => this.stop(root));
  }

  public static isWatching(repoPath: string): boolean {
    return this.states.has(path.resolve(repoPath));
  }

  /**
   * Changes since the last call: null when not watching (walk everything), 'all' when anything may have changed,
   * otherwise the changed repo-relative paths. Resets the record.
   */
  public static takeChanges(repoPath: string): Set<string> | 'all' | null {
    const state = this.states.get(path.resolve(repoPath));
    if (!state) return null;
    if (Date.now() - state.startedAt < WATCH_WARMUP_MS) {
      state.dirty = new Set();
      return 'all';
    }
    const dirty = state.dirty;
    state.dirty = new Set();
    return dirty;
  }
}
