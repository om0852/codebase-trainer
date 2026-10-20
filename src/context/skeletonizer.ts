import * as path from 'path';

export interface SkeletonResult {
  originalTokens: number;
  skeletonTokens: number;
  compressionRatio: number; // e.g. 0.35 means compressed to 35% of original size
  skeleton: string;
}

export class ASTSkeletonizer {
  /**
   * Fast, reliable token estimation matching standard BPE code tokenizers (~3.7 - 4 chars/token).
   */
  public static estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;
    const tokens = text.match(/\w+|[^\w\s]+/g);
    if (!tokens) return Math.ceil(text.length / 4);
    // BPE tokenizers split compound identifiers, punctuation, indentation
    return Math.max(1, Math.ceil(tokens.length * 1.15));
  }

  /**
   * Determines language from file extension or path.
   */
  public static detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'typescript';
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
    if (ext === '.py') return 'python';
    if (ext === '.go') return 'go';
    if (ext === '.rs') return 'rust';
    if (ext === '.java') return 'java';
    if (['.c', '.cpp', '.cc', '.h', '.hpp'].includes(ext)) return 'cpp';
    return 'generic';
  }

  /**
   * Compresses code into a structural AST skeleton by preserving declarations,
   * interfaces, types, signatures, and docstrings while stripping function/method bodies.
   */
  public static skeletonize(code: string, languageOrFilePath: string = 'typescript'): SkeletonResult {
    const lang = languageOrFilePath.includes('.') 
      ? this.detectLanguage(languageOrFilePath) 
      : languageOrFilePath.toLowerCase();

    const originalTokens = this.estimateTokens(code);
    let skeleton = code;

    if (lang === 'python') {
      skeleton = this.skeletonizePython(code);
    } else {
      skeleton = this.skeletonizeCurlyBraceLang(code);
    }

    const skeletonTokens = this.estimateTokens(skeleton);
    const compressionRatio = originalTokens > 0 
      ? Number((skeletonTokens / originalTokens).toFixed(2)) 
      : 1.0;

    return {
      originalTokens,
      skeletonTokens,
      compressionRatio,
      skeleton
    };
  }

  /**
   * Skeletonizes curly-brace languages (TypeScript, JavaScript, Go, Rust, Java, C++).
   */
  private static skeletonizeCurlyBraceLang(code: string): string {
    const lines = code.split(/\r?\n/);
    const result: string[] = [];
    let insideDocstring = false;
    let braceDepth = 0;
    let inFunctionBody = false;
    let bodyBraceStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Preserve JSDocs / Block Comments
      if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
        insideDocstring = true;
        result.push(line);
        if (trimmed.includes('*/') && !trimmed.startsWith('/**/')) {
          insideDocstring = false;
        }
        continue;
      }
      if (insideDocstring) {
        result.push(line);
        if (trimmed.includes('*/')) {
          insideDocstring = false;
        }
        continue;
      }

      // Preserve single line comments if they are annotations (TODO, FIXME, @param, etc.)
      if (trimmed.startsWith('//') && (trimmed.includes('@') || trimmed.includes('TODO') || trimmed.includes('NOTE'))) {
        result.push(line);
        continue;
      }

      // Preserve Imports, Exports, Interfaces, Types
      if (
        trimmed.startsWith('import ') ||
        trimmed.startsWith('export type ') ||
        trimmed.startsWith('export interface ') ||
        trimmed.startsWith('type ') ||
        trimmed.startsWith('interface ') ||
        trimmed.startsWith('package ')
      ) {
        result.push(line);
        continue;
      }

      // Detect function / method / constructor declaration with body open
      const isFunctionHeader =
        /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+[A-Za-z0-9_$]*/.test(trimmed) ||
        /(?:public|private|protected|static|async|\s)*[A-Za-z0-9_$]+\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{/.test(trimmed) ||
        /(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?\([^)]*\)(?:\s*:\s*[^{]+)?\s*=>\s*\{/.test(trimmed) ||
        /(?:func|fn)\s+(?:\([^)]+\)\s+)?[A-Za-z0-9_$]+\s*\([^)]*\)/.test(trimmed);

      // Track brace depth
      const openCount = (line.match(/\{/g) || []).length;
      const closeCount = (line.match(/\}/g) || []).length;

      if (!inFunctionBody) {
        if (isFunctionHeader && line.includes('{')) {
          // If function opens on the same line
          const header = line.substring(0, line.indexOf('{') + 1);
          result.push(header + ' /* ... implementation ... */ }');
          
          if (openCount > closeCount) {
            inFunctionBody = true;
            bodyBraceStart = braceDepth;
            braceDepth += (openCount - closeCount);
          }
          continue;
        } else if (isFunctionHeader) {
          result.push(line);
          continue;
        }

        // Inside class or root
        if (openCount !== closeCount) {
          braceDepth += (openCount - closeCount);
        }
        // Only output if not empty
        if (trimmed.length > 0 && !trimmed.startsWith('//')) {
          result.push(line);
        }
      } else {
        // We are inside a function body to be skipped
        braceDepth += (openCount - closeCount);
        if (braceDepth <= bodyBraceStart) {
          // Exited function body
          inFunctionBody = false;
        }
      }
    }

    return result.join('\n');
  }

  /**
   * Skeletonizes Python code by keeping def/class/docstrings and replacing bodies with `...`.
   */
  private static skeletonizePython(code: string): string {
    const lines = code.split(/\r?\n/);
    const result: string[] = [];
    let insideDocstring = false;
    let skippingBody = false;
    let bodyIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Preserve docstrings
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        const quote = trimmed.startsWith('"""') ? '"""' : "'''";
        result.push(line);
        if (trimmed.length > 3 && trimmed.endsWith(quote) && trimmed !== quote) {
          insideDocstring = false;
        } else {
          insideDocstring = !insideDocstring;
        }
        continue;
      }
      if (insideDocstring) {
        result.push(line);
        continue;
      }

      // Check indentation level
      const indent = line.search(/\S|$/);

      if (skippingBody) {
        if (indent > bodyIndent && trimmed.length > 0) {
          continue; // skip body line
        } else if (trimmed.length > 0) {
          skippingBody = false;
        }
      }

      // Check imports
      if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
        result.push(line);
        continue;
      }

      // Check class / def
      if (trimmed.startsWith('def ') || trimmed.startsWith('class ') || trimmed.startsWith('@')) {
        result.push(line);
        if (trimmed.endsWith(':')) {
          skippingBody = true;
          bodyIndent = indent;
          result.push(' '.repeat(indent + 4) + '...');
        }
        continue;
      }

      // Global constants or variable annotations
      if (/^[A-Z0-9_]+\s*(?::\s*[^=]+)?\s*=/.test(trimmed)) {
        result.push(line);
        continue;
      }
    }

    return result.join('\n');
  }
}
