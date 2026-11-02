import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Language, Parser, Tree } from 'web-tree-sitter';

export type GrammarName = 'typescript' | 'tsx' | 'javascript' | 'python';

const GRAMMAR_FILES: Record<GrammarName, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm'
};

const EXTENSION_GRAMMAR: Record<string, GrammarName> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  // The JavaScript grammar understands JSX
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python'
};

// `grammars/` sits at the package root: two levels above both src/parsing and dist/parsing
const GRAMMAR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars');

/**
 * Tree-sitter parsing. `web-tree-sitter` loads its runtime and grammars asynchronously, so `init()` runs once at
 * startup (CLI, MCP server, tests, benchmark); after that `parse()` is synchronous. Until `init()` has
 * succeeded `parse()` returns null, and callers fall back to the regex extractors.
 */
export class TreeSitter {
  private static parsers = new Map<GrammarName, Parser>();
  private static initPromise: Promise<boolean> | null = null;
  private static failure: string | null = null;

  public static init(): Promise<boolean> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // Escape hatch and A/B switch for the benchmark: force the regex extractors
        if (process.env.CODEBASE_TRAINER_PARSER === 'regex') return false;
        try {
          await Parser.init();
          for (const [name, file] of Object.entries(GRAMMAR_FILES) as Array<[GrammarName, string]>) {
            const wasm = path.join(GRAMMAR_DIR, file);
            if (!fs.existsSync(wasm)) continue;
            const parser = new Parser();
            parser.setLanguage(await Language.load(wasm));
            this.parsers.set(name, parser);
          }
          return this.parsers.size > 0;
        } catch (err) {
          // Keep working with the regex extractors rather than failing the whole tool
          this.failure = err instanceof Error ? err.message : String(err);
          this.parsers.clear();
          return false;
        }
      })();
    }
    return this.initPromise;
  }

  public static isReady(): boolean {
    return this.parsers.size > 0;
  }

  /** Why init() failed, if it did (for diagnostics). */
  public static initError(): string | null {
    return this.failure;
  }

  public static grammarFor(filePath: string): GrammarName | null {
    return EXTENSION_GRAMMAR[path.extname(filePath).toLowerCase()] ?? null;
  }

  /**
   * Syntax tree for a file, or null when the parser is not initialised, the language is unsupported, or
   * parsing fails. The caller owns the tree and should call `tree.delete()` when done (WASM memory).
   */
  public static parse(filePath: string, content: string): Tree | null {
    const grammar = this.grammarFor(filePath);
    const parser = grammar ? this.parsers.get(grammar) : undefined;
    if (!parser) return null;
    try {
      return parser.parse(content);
    } catch {
      return null;
    }
  }
}
