import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ASTFact } from '../types/index.js';

export interface CodebaseIndexStore {
  lastScannedAt: string;
  fileHashes: Record<string, string>;
  facts: ASTFact[];
}

export class IndexStore {
  private static getDbPath(repoPath: string): string {
    return path.join(repoPath, '.codebase', 'index.db.json');
  }

  public static getFileHash(filePath: string): string {
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  }

  public static saveIndex(repoPath: string, facts: ASTFact[]): void {
    const dbPath = this.getDbPath(repoPath);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fileHashes: Record<string, string> = {};
    facts.forEach(f => {
      fileHashes[f.filePath] = this.getFileHash(f.filePath);
    });

    const data: CodebaseIndexStore = {
      lastScannedAt: new Date().toISOString(),
      fileHashes,
      facts
    };

    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  }

  public static loadIndex(repoPath: string): CodebaseIndexStore | null {
    const dbPath = this.getDbPath(repoPath);
    if (!fs.existsSync(dbPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch {
      return null;
    }
  }

  public static getChangedFiles(repoPath: string, facts: ASTFact[]): string[] {
    const index = this.loadIndex(repoPath);
    if (!index) return facts.map(f => f.filePath);

    const changed: string[] = [];
    facts.forEach(f => {
      const currentHash = this.getFileHash(f.filePath);
      const oldHash = index.fileHashes[f.filePath];
      if (currentHash !== oldHash) {
        changed.push(f.filePath);
      }
    });
    return changed;
  }
}
