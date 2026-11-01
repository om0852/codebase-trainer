export interface DiffLine {
  // 1-based line number in the new file (added lines) or the old file (removed lines)
  line: number;
  text: string;
}

export interface DiffFile {
  // Repo-relative POSIX path after the change (the old path for deleted files)
  filePath: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  addedLines: DiffLine[];
  removedLines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses unified diffs as produced by `git diff` (with or without `diff --git` headers).
 */
export class DiffParser {
  /**
   * True when the text contains at least one file header and one hunk header. Prose, code snippets and
   * summaries of a change are rejected rather than silently "passing".
   */
  public static looksLikeDiff(text: string): boolean {
    return /^(?:\+\+\+ |--- )/m.test(text) && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);
  }

  public static parse(diff: string): DiffFile[] {
    const files: DiffFile[] = [];
    let current: DiffFile | null = null;
    let sawNewHeader = false;
    let oldLine = 0;
    let newLine = 0;
    // Remaining old/new lines in the current hunk, from its `@@ -a,b +c,d @@` header. Counting (rather
    // than pattern-matching) is what keeps a removed line like `-- comment` from looking like a file header.
    let oldLeft = 0;
    let newLeft = 0;

    const startFile = () => {
      current = { filePath: '', status: 'modified', addedLines: [], removedLines: [] };
      files.push(current);
      sawNewHeader = false;
    };

    for (const raw of diff.split(/\r?\n/)) {
      if (current && (oldLeft > 0 || newLeft > 0)) {
        const file: DiffFile = current;
        if (raw.startsWith('+')) {
          file.addedLines.push({ line: newLine++, text: raw.slice(1) });
          newLeft--;
        } else if (raw.startsWith('-')) {
          file.removedLines.push({ line: oldLine++, text: raw.slice(1) });
          oldLeft--;
        } else if (raw.startsWith(' ') || raw === '') {
          oldLine++;
          newLine++;
          oldLeft--;
          newLeft--;
        }
        // `\ No newline at end of file` advances neither side
        continue;
      }

      if (raw.startsWith('diff --git ')) {
        startFile();
        const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (m) {
          current!.oldPath = m[1];
          current!.filePath = m[2];
        }
        continue;
      }
      // Plain unified diffs have no `diff --git` line: a `---` after the previous file's `+++` starts a new file
      if (raw.startsWith('--- ') && (!current || sawNewHeader)) startFile();
      if (!current) continue;
      const file: DiffFile = current;

      const hunk = raw.match(HUNK_HEADER);
      if (hunk) {
        oldLine = parseInt(hunk[1], 10);
        newLine = parseInt(hunk[3], 10);
        oldLeft = hunk[2] !== undefined ? parseInt(hunk[2], 10) : 1;
        newLeft = hunk[4] !== undefined ? parseInt(hunk[4], 10) : 1;
      } else if (raw.startsWith('new file mode')) {
        file.status = 'added';
      } else if (raw.startsWith('deleted file mode')) {
        file.status = 'deleted';
      } else if (raw.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = raw.slice('rename from '.length);
      } else if (raw.startsWith('rename to ')) {
        file.filePath = raw.slice('rename to '.length);
      } else if (raw.startsWith('--- ')) {
        const oldPath = this.stripPrefix(raw.slice(4));
        if (oldPath === null) file.status = 'added';
        else file.oldPath = oldPath;
      } else if (raw.startsWith('+++ ')) {
        sawNewHeader = true;
        const newPath = this.stripPrefix(raw.slice(4));
        if (newPath === null) {
          file.status = 'deleted';
          file.filePath = file.oldPath || file.filePath;
        } else {
          file.filePath = newPath;
        }
      }
    }

    return files.filter(f => f.filePath);
  }

  /**
   * Treats a whole file as added (for untracked files, or reviewing a file outside a diff).
   */
  public static asAddedFile(filePath: string, content: string): DiffFile {
    return {
      filePath,
      status: 'added',
      addedLines: content.split(/\r?\n/).map((text, idx) => ({ line: idx + 1, text })),
      removedLines: []
    };
  }

  // `a/src/x.ts` -> `src/x.ts`; `/dev/null` -> null; strips a trailing tab + timestamp
  private static stripPrefix(header: string): string | null {
    const p = header.split('\t')[0].trim();
    if (p === '/dev/null') return null;
    return p.replace(/^[ab]\//, '');
  }
}
