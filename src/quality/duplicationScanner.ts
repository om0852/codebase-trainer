import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { IntentClassifier } from '../classifier/intentClassifier.js';

export interface DuplicateOccurrence {
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface DuplicateBlock {
  // Significant (non-blank, non-comment, non-brace) lines in the block
  lines: number;
  occurrences: DuplicateOccurrence[];
  snippet: string;
}

export interface DuplicationReport {
  scannedFiles: number;
  significantLines: number;
  duplicatedLines: number;
  duplicationPercent: number;
  blocks: DuplicateBlock[];
  minLines: number;
  notes: string[];
}

export interface DuplicationOptions {
  // Smallest clone reported, in significant lines
  minLines?: number;
  maxBlocks?: number;
  includeTests?: boolean;
}

interface SignificantLine {
  text: string;
  line: number;
}

interface Window {
  file: number;
  index: number;
}

const CODE_LANGUAGES = new Set(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'cpp', 'php']);

/**
 * Finds exact (whitespace-insensitive) duplicated blocks across code files by hashing sliding windows of
 * significant lines and growing matching windows into maximal blocks. Renamed-variable clones are not detected.
 */
export class DuplicationScanner {
  public static scan(repoPath: string, options: DuplicationOptions = {}): DuplicationReport {
    const minLines = options.minLines ?? 6;
    const maxBlocks = options.maxBlocks ?? 20;
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');

    const files = ASTExtractor.scanDirectory(repoPath)
      .filter(f => CODE_LANGUAGES.has(f.language))
      .filter(f => options.includeTests || !IntentClassifier.isTestFile(toRel(f.filePath)))
      .map(f => ({ rel: toRel(f.filePath), lines: this.significantLines(this.read(f.filePath), f.language === 'python') }));

    // window hash -> every place it occurs
    const windowHashes: string[][] = files.map(() => []);
    const byHash = new Map<string, Window[]>();
    files.forEach((file, fileIdx) => {
      for (let i = 0; i + minLines <= file.lines.length; i++) {
        const hash = crypto.createHash('sha1').update(file.lines.slice(i, i + minLines).map(l => l.text).join('\n')).digest('hex');
        windowHashes[fileIdx][i] = hash;
        const list = byHash.get(hash);
        if (list) list.push({ file: fileIdx, index: i });
        else byHash.set(hash, [{ file: fileIdx, index: i }]);
      }
    });

    // Lines covered by any duplicated window, for the overall percentage
    const covered = files.map(() => new Set<number>());
    byHash.forEach(windows => {
      if (windows.length < 2) return;
      windows.forEach(w => { for (let k = 0; k < minLines; k++) covered[w.file].add(w.index + k); });
    });

    const consumed = new Set<string>();
    const blocks: DuplicateBlock[] = [];
    files.forEach((file, fileIdx) => {
      for (let i = 0; i < windowHashes[fileIdx].length; i++) {
        const hash = windowHashes[fileIdx][i];
        if (consumed.has(`${fileIdx}:${i}`)) continue;
        const occurrences = this.distinctOccurrences(byHash.get(hash) || [], minLines);
        if (occurrences.length < 2) continue;

        // Grow the block while every occurrence's next window still matches the first one's
        let extra = 0;
        while (occurrences.every(o => {
          const next = windowHashes[o.file][o.index + extra + 1];
          return next !== undefined && next === windowHashes[occurrences[0].file][occurrences[0].index + extra + 1];
        })) {
          extra++;
        }
        occurrences.forEach(o => { for (let k = 0; k <= extra; k++) consumed.add(`${o.file}:${o.index + k}`); });

        const length = minLines + extra;
        blocks.push({
          lines: length,
          occurrences: occurrences.map(o => ({
            filePath: files[o.file].rel,
            startLine: files[o.file].lines[o.index].line,
            endLine: files[o.file].lines[o.index + length - 1].line
          })),
          snippet: files[fileIdx].lines.slice(i, i + Math.min(length, 4)).map(l => l.text).join('\n')
        });
      }
    });

    blocks.sort((a, b) => b.lines * (b.occurrences.length - 1) - a.lines * (a.occurrences.length - 1));
    // A block whose every copy sits inside an already-reported block's copies is a slice of that clone
    const overlaps = (a: DuplicateOccurrence, b: DuplicateOccurrence) =>
      a.filePath === b.filePath && a.startLine <= b.endLine && b.startLine <= a.endLine;
    const reported: DuplicateBlock[] = [];
    blocks.forEach(block => {
      const isSlice = reported.some(r => block.occurrences.every(o => r.occurrences.some(ro => overlaps(o, ro))));
      if (!isSlice) reported.push(block);
    });
    const significantLines = files.reduce((n, f) => n + f.lines.length, 0);
    const duplicatedLines = covered.reduce((n, s) => n + s.size, 0);
    const notes = [
      `Exact clones of at least ${minLines} significant lines (blank lines, comments, imports and lone brackets ignored; whitespace-insensitive). Clones with renamed variables are not detected.`
    ];
    if (!options.includeTests) notes.push('Test files are excluded.');
    if (reported.length > maxBlocks) notes.push(`Showing the ${maxBlocks} largest of ${reported.length} duplicated blocks.`);

    return {
      scannedFiles: files.length,
      significantLines,
      duplicatedLines,
      duplicationPercent: significantLines > 0 ? Number(((duplicatedLines / significantLines) * 100).toFixed(1)) : 0,
      blocks: reported.slice(0, maxBlocks),
      minLines,
      notes
    };
  }

  // Drops occurrences that overlap an earlier one in the same file (runs of repeated lines)
  private static distinctOccurrences(windows: Window[], minLines: number): Window[] {
    const kept: Window[] = [];
    windows.forEach(w => {
      if (!kept.some(k => k.file === w.file && Math.abs(k.index - w.index) < minLines)) kept.push(w);
    });
    return kept;
  }

  private static significantLines(content: string, isPython: boolean): SignificantLine[] {
    const result: SignificantLine[] = [];
    let inBlockComment = false;
    content.split(/\r?\n/).forEach((raw, idx) => {
      let text = raw.trim();
      if (!isPython) {
        if (inBlockComment) {
          if (text.includes('*/')) inBlockComment = false;
          return;
        }
        if (text.startsWith('/*') && !text.includes('*/')) {
          inBlockComment = true;
          return;
        }
      }
      if (!text) return;
      if (isPython ? text.startsWith('#') : /^(\/\/|\/\*.*\*\/$|\*)/.test(text)) return;
      if (/^(import\s|from\s+\S+\s+import\s|export\s+\*\s+from|export\s*\{[^}]*\}\s*from|#include|using\s|package\s)/.test(text)) return;
      if (/^[{}()[\];,]+$/.test(text) || /^(\}\s*\)?;?|\)\s*;?|\]\s*;?)$/.test(text)) return;
      text = text.replace(/\s+/g, ' ');
      result.push({ text, line: idx + 1 });
    });
    return result;
  }

  private static read(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }
}
