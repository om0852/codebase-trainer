import * as fs from 'fs';
import * as path from 'path';
import { ASTFact } from '../types/index.js';
import { SecretSanitizer } from '../security/secretSanitizer.js';

export class ASTExtractor {
  public static extractFileFacts(filePath: string): ASTFact | null {
    if (!fs.existsSync(filePath)) return null;

    try {
      const stats = fs.statSync(filePath);
      // Skip giant data files (> 500KB)
      if (stats.size > 500 * 1024) return null;
    } catch {
      return null;
    }

    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    const lines = content.split(/\r?\n/);
    const ext = path.extname(filePath).toLowerCase();

    let language = 'unknown';
    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      language = ['.ts', '.tsx', '.mts', '.cts'].includes(ext) ? 'typescript' : 'javascript';
    } else if (ext === '.py') {
      language = 'python';
    } else if (ext === '.go') {
      language = 'go';
    } else if (ext === '.rs') {
      language = 'rust';
    } else if (ext === '.java') {
      language = 'java';
    } else if (['.c', '.cpp', '.cc', '.h', '.hpp'].includes(ext)) {
      language = 'cpp';
    } else if (ext === '.sql') {
      language = 'sql';
    } else if (ext === '.php') {
      language = 'php';
    } else if (['.md', '.markdown', '.json'].includes(ext)) {
      language = ext.replace('.', '');
    } else {
      return null;
    }

    // Analyze Constants Placement
    let constTopCount = 0;
    let constInlineCount = 0;
    let constRegex = /(const|let|var)\s+[A-Z0-9_]+\s*=/;
    if (language === 'python') constRegex = /^[A-Z0-9_]+\s*=/;
    if (language === 'go') constRegex = /(const|var)\s+[A-Z0-9_]+/;
    if (language === 'rust') constRegex = /(const|static)\s+[A-Z0-9_]+/;

    lines.forEach((line: string, idx: number) => {
      if (constRegex.test(line.trim())) {
        if (idx < 30) {
          constTopCount++;
        } else {
          constInlineCount++;
        }
      }
    });

    let constantsPlacement: 'top' | 'inline' | 'mixed' = 'top';
    if (constInlineCount > 0 && constTopCount > 0) constantsPlacement = 'mixed';
    else if (constInlineCount > constTopCount) constantsPlacement = 'inline';

    // Analyze Export Style
    let namedExports = 0;
    let defaultExports = 0;
    if (['typescript', 'javascript'].includes(language)) {
      lines.forEach((line: string) => {
        if (/export\s+default/.test(line)) defaultExports++;
        else if (/export\s+(const|function|class|interface|type|enum)/.test(line)) namedExports++;
      });
    } else if (language === 'go') {
      lines.forEach((line: string) => {
        if (/^func\s+[A-Z]/.test(line.trim())) namedExports++;
      });
    } else if (language === 'rust') {
      lines.forEach((line: string) => {
        if (/^pub\s+fn/.test(line.trim())) namedExports++;
      });
    }

    let exportStyle: 'named' | 'default' | 'mixed' = 'named';
    if (defaultExports > 0 && namedExports > 0) exportStyle = 'mixed';
    else if (defaultExports > namedExports) exportStyle = 'default';

    // Analyze Imports
    const importedModules: string[] = [];
    let importRegex = /(?:import|require)\(['"]?([^'"\)]+)['"]?\)?/;
    if (language === 'python') importRegex = /^(?:import|from)\s+([a-zA-Z0-9_\.]+)/;
    if (language === 'go') importRegex = /import\s+[\(\s]*["']([^"']+)["']/;
    if (language === 'rust') importRegex = /^use\s+([a-zA-Z0-9_:]+)/;
    if (language === 'java') importRegex = /^import\s+([a-zA-Z0-9_\.]+);/;

    lines.forEach((line: string) => {
      const match = line.trim().match(importRegex);
      if (match && match[1]) {
        importedModules.push(match[1]);
      }
    });

    // Function metrics
    let funcCount = 0;
    let funcRegex = /(function\s+\w+|\w+\s*=\s*\(.*?\)\s*=>)/;
    if (language === 'python') funcRegex = /^\s*def\s+/;
    if (language === 'go') funcRegex = /^func\s+/;
    if (language === 'rust') funcRegex = /^\s*(pub\s+)?fn\s+/;
    if (language === 'java') funcRegex = /^\s*(public|private|protected)?\s+(static\s+)?\w+\s+\w+\s*\(/;

    lines.forEach((line: string) => {
      if (funcRegex.test(line)) funcCount++;
    });

    const avgFuncLength = funcCount > 0 ? Math.round(lines.length / funcCount) : lines.length;
    const typeCastingCount = (content.match(/as\s+[A-Z]\w*/g) || []).length;
    const hasTypeAnnotations = ['typescript', 'go', 'rust', 'java', 'cpp'].includes(language) || /:\s*(string|number|boolean|any)/.test(content);

    // Extract declared symbols (functions, classes, interfaces, types)
    const symbols = new Set<string>();
    const symbolMatches = content.matchAll(/(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g);
    for (const m of symbolMatches) {
      if (m[1]) symbols.add(m[1]);
    }

    // Also match const/let function definitions
    const arrowMatches = content.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g);
    for (const m of arrowMatches) {
      if (m[1]) symbols.add(m[1]);
    }

    // Python def/class/async def
    if (language === 'python') {
      const pyMatches = content.matchAll(/^(?:\s*)?(?:async\s+)?(?:def|class)\s+([A-Za-z0-9_]+)/gm);
      for (const m of pyMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // Go func, struct, interface
    if (language === 'go') {
      const goMatches = content.matchAll(/(?:func\s+(?:\([^)]+\)\s+)?|type\s+)([A-Za-z0-9_]+)\s*(?:struct|interface|\()/g);
      for (const m of goMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // Rust fn, struct, enum, trait
    if (language === 'rust') {
      const rustMatches = content.matchAll(/(?:pub\s+)?(?:fn|struct|enum|trait|type|impl)\s+([A-Za-z0-9_]+)/g);
      for (const m of rustMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // Java / C++ class, interface, method
    if (['java', 'cpp'].includes(language)) {
      const javaMatches = content.matchAll(/(?:class|interface|struct)\s+([A-Za-z0-9_]+)/g);
      for (const m of javaMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    // SQL tables and views
    if (ext === '.sql') {
      const sqlMatches = content.matchAll(/CREATE\s+(?:TABLE|VIEW|PROCEDURE|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi);
      for (const m of sqlMatches) {
        if (m[1]) symbols.add(m[1]);
      }
    }

    return {
      filePath,
      language,
      constantsPlacement,
      exportStyle,
      hasTypeAnnotations,
      typeCastingCount,
      importedModules,
      funcCount,
      avgFuncLength,
      symbols: Array.from(symbols)
    };
  }

  public static scanDirectory(dirPath: string): ASTFact[] {
    const facts: ASTFact[] = [];
    const ignoreDirs = [
      'node_modules', '.git', '.codebase', 'dist', 'build', '.next', 'vendor',
      'target', '.venv', 'venv', 'env', '.env', '__pycache__', 'coverage',
      '.pytest_cache', 'site-packages', '.cache', 'lib', 'Lib', 'data', 'models'
    ];

    function walk(currentDir: string) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!ignoreDirs.includes(entry.name)) {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          // Check secret / ignore patterns
          if (SecretSanitizer.isIgnoredFile(fullPath, dirPath)) {
            continue;
          }
          const fact = ASTExtractor.extractFileFacts(fullPath);
          if (fact) facts.push(fact);
        }
      }
    }

    walk(dirPath);
    return facts;
  }
}
