import * as fs from 'fs';
import * as path from 'path';
import { ASTFact } from '../types/index.js';
import { ImportResolver } from '../graph/importResolver.js';
import { ContractDriftDetector } from '../microservices/contractDrift.js';

export type FlowEdgeKind = 'call' | 'reference' | 'http';

export interface FlowEdge {
  kind: FlowEdgeKind;
  // Repo-relative POSIX paths
  from: { filePath: string; symbol?: string; line: number };
  to: { filePath: string; symbol?: string; line?: number };
  // The source line the edge was read from
  evidence: string;
  // HTTP edges: "DELETE /api/keys/[id]"
  label?: string;
}

export interface ImportBinding {
  specifier: string;
  local: string;
  // Exported name, 'default', or '*' for namespace / CommonJS module objects
  imported: string;
  // 1-based line of the import statement
  line?: number;
  typeOnly?: boolean;
}

const NOT_FUNCTION_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try', 'constructor']);

/**
 * Derives symbol-level edges from resolved imports: for every binding a file imports, the lines where
 * it is called (`fn()`, `new C()`, `C.method()`, `ns.fn()`, `<Component>`) become `call` edges, other value
 * uses become `reference` edges, and client fetch/axios calls are linked to matching route handlers as
 * `http` edges. Each edge carries the file, line and enclosing function it was read from.
 */
export class CallSiteExtractor {
  public static extractEdges(repoPath: string, facts: ASTFact[]): FlowEdge[] {
    const resolver = ImportResolver.forFacts(repoPath, facts);
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');
    const contentCache = new Map<string, string>();
    const read = (file: string): string => {
      if (!contentCache.has(file)) {
        try {
          contentCache.set(file, fs.readFileSync(file, 'utf8'));
        } catch {
          contentCache.set(file, '');
        }
      }
      return contentCache.get(file)!;
    };

    const edges: FlowEdge[] = [];
    facts.forEach(fact => {
      if (!['typescript', 'javascript', 'python'].includes(fact.language)) return;
      const content = read(fact.filePath);
      if (!content) return;
      const lines = content.split(/\r?\n/);
      const isPython = fact.language === 'python';
      const allowJsx = /\.(jsx|tsx)$/i.test(fact.filePath);
      const { bindings, importLines } = isPython ? this.parsePythonImports(content) : this.parseJsImports(content);

      const fileEdges = new Map<string, FlowEdge>();
      bindings.forEach(binding => {
        const target = resolver.resolve(fact.filePath, binding.specifier, fact.language);
        if (!target || target === fact.filePath) return;
        const targetContent = read(target);

        lines.forEach((line, idx) => {
          if (importLines.has(idx) || /^\s*(\/\/|\*|#)/.test(line)) return;
          this.findUses(line, binding, isPython, allowJsx).forEach(use => {
            const fromSymbol = this.enclosingSymbol(lines, idx, isPython);
            const key = `${use.kind}|${toRel(target)}|${use.symbol}|${fromSymbol || ''}`;
            if (fileEdges.has(key)) return;
            fileEdges.set(key, {
              kind: use.kind,
              from: { filePath: toRel(fact.filePath), symbol: fromSymbol, line: idx + 1 },
              to: { filePath: toRel(target), symbol: use.symbol, line: this.findDefinitionLine(targetContent, use.symbol) },
              evidence: line.trim()
            });
          });
        });
      });

      // A reference edge adds nothing when the same function already calls the target
      const called = new Set(Array.from(fileEdges.values()).filter(e => e.kind === 'call').map(e => `${e.to.filePath}|${e.from.symbol || ''}`));
      fileEdges.forEach(edge => {
        if (edge.kind === 'reference' && called.has(`${edge.to.filePath}|${edge.from.symbol || ''}`)) return;
        edges.push(edge);
      });
    });

    edges.push(...this.extractHttpEdges(repoPath, read));
    return edges;
  }

  /**
   * Links client fetch/axios calls to server route handlers with the same method and normalized path.
   */
  public static extractHttpEdges(repoPath: string, read: (absPath: string) => string = f => fs.readFileSync(f, 'utf8')): FlowEdge[] {
    const servers = ContractDriftDetector.extractServerEndpoints(repoPath);
    const byKey = new Map<string, typeof servers>();
    servers.forEach(ep => {
      const key = `${ep.method}:${ContractDriftDetector.normalizePath(ep.endpoint)}`;
      byKey.set(key, [...(byKey.get(key) || []), ep]);
    });

    const edges: FlowEdge[] = [];
    ContractDriftDetector.extractClientCalls(repoPath).forEach(call => {
      const matches = byKey.get(`${call.method}:${ContractDriftDetector.normalizePath(call.endpoint)}`) || [];
      matches.forEach(ep => {
        const clientLines = read(path.join(repoPath, call.filePath)).split(/\r?\n/);
        const serverLines = read(path.join(repoPath, ep.filePath)).split(/\r?\n/);
        const clientPython = call.filePath.endsWith('.py');
        const serverPython = ep.filePath.endsWith('.py');
        // Next.js handlers are named after the method; Express handlers are usually inline callbacks
        const handlerSymbol = /^\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b/.test(serverLines[ep.line - 1] || '')
          ? ep.method
          : this.enclosingSymbol(serverLines, ep.line - 1, serverPython);
        edges.push({
          kind: 'http',
          from: {
            filePath: call.filePath.replace(/\\/g, '/'),
            symbol: this.enclosingSymbol(clientLines, call.line - 1, clientPython),
            line: call.line
          },
          to: { filePath: ep.filePath.replace(/\\/g, '/'), symbol: handlerSymbol, line: ep.line },
          evidence: (clientLines[call.line - 1] || '').trim(),
          label: `${call.method} ${ep.endpoint}`
        });
      });
    });
    return edges;
  }

  /**
   * Import bindings of a JS/TS file. Type-only bindings bring in no runtime values, so they are skipped
   * unless `includeTypeOnly` is set (e.g. to find importers broken by a removed interface).
   */
  public static parseJsImports(content: string, includeTypeOnly: boolean = false): { bindings: ImportBinding[]; importLines: Set<number> } {
    const bindings: ImportBinding[] = [];
    const importLines = new Set<number>();
    const lineOf = (index: number) => content.slice(0, index).split('\n').length - 1;
    const markLines = (start: number, end: number) => {
      for (let l = lineOf(start); l <= lineOf(end); l++) importLines.add(l);
    };

    for (const m of content.matchAll(/(?:^|[\s;])import\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s+['"]([^'"\n]+)['"]/g)) {
      markLines(m.index!, m.index! + m[0].length);
      if (m[1] && !includeTypeOnly) continue;
      const specifier = m[3];
      const line = lineOf(m.index! + m[0].indexOf('import')) + 1;
      const statementTypeOnly = Boolean(m[1]);
      let clause = m[2].trim();

      const braceStart = clause.indexOf('{');
      if (braceStart >= 0) {
        clause.slice(braceStart + 1, clause.lastIndexOf('}')).split(',').forEach(item => {
          let trimmed = item.trim();
          const itemTypeOnly = statementTypeOnly || trimmed.startsWith('type ');
          if (!trimmed || (itemTypeOnly && !includeTypeOnly)) return;
          trimmed = trimmed.replace(/^type\s+/, '');
          const [imported, local] = trimmed.split(/\s+as\s+/).map(s => s.trim());
          bindings.push({ specifier, imported, local: local || imported, line, typeOnly: itemTypeOnly });
        });
        clause = clause.slice(0, braceStart);
      }
      clause.split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
        const ns = part.match(/^\*\s+as\s+([\w$]+)$/);
        if (ns) bindings.push({ specifier, imported: '*', local: ns[1], line, typeOnly: statementTypeOnly });
        else if (/^[\w$]+$/.test(part)) bindings.push({ specifier, imported: 'default', local: part, line, typeOnly: statementTypeOnly });
      });
    }

    for (const m of content.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
      markLines(m.index!, m.index! + m[0].length);
      const specifier = m[2];
      if (m[1].startsWith('{')) {
        m[1].slice(1, -1).split(',').forEach(item => {
          const [imported, local] = item.split(':').map(s => s.trim());
          if (imported) bindings.push({ specifier, imported, local: local || imported });
        });
      } else {
        bindings.push({ specifier, imported: '*', local: m[1] });
      }
    }

    return { bindings, importLines };
  }

  private static parsePythonImports(content: string): { bindings: ImportBinding[]; importLines: Set<number> } {
    const bindings: ImportBinding[] = [];
    const importLines = new Set<number>();
    content.split(/\r?\n/).forEach((line, idx) => {
      const fromImport = line.match(/^\s*from\s+([\w.]+)\s+import\s+\(?([^)#]+)\)?/);
      if (fromImport) {
        importLines.add(idx);
        fromImport[2].split(',').forEach(item => {
          const [imported, local] = item.trim().split(/\s+as\s+/).map(s => s.trim());
          if (imported && imported !== '*') bindings.push({ specifier: fromImport[1], imported, local: local || imported });
        });
        return;
      }
      const plainImport = line.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
      if (plainImport) {
        importLines.add(idx);
        bindings.push({ specifier: plainImport[1], imported: '*', local: plainImport[2] || plainImport[1] });
      }
    });
    return { bindings, importLines };
  }

  private static findUses(line: string, binding: ImportBinding, isPython: boolean, allowJsx: boolean): Array<{ kind: 'call' | 'reference'; symbol: string }> {
    const local = binding.local.replace(/[.$]/g, '\\$&');
    const uses: Array<{ kind: 'call' | 'reference'; symbol: string }> = [];
    const baseName = binding.imported === '*' || binding.imported === 'default' ? binding.local : binding.imported;

    // `ns.fn(`, `Class.method(`, `<ns.Component`
    for (const m of line.matchAll(new RegExp(`(?<![\\w$.])${local}\\.([\\w$]+)\\s*\\(`, 'g'))) {
      uses.push({ kind: 'call', symbol: binding.imported === '*' ? m[1] : `${baseName}.${m[1]}` });
    }
    // `fn(`, `new Class(`, `<Component` (JSX render; only in .jsx/.tsx so `Array<Foo>` is not a render)
    const direct = new RegExp(`(?<![\\w$.])${local}\\s*\\(|\\bnew\\s+${local}\\b${allowJsx ? `|<${local}[\\s/>]` : ''}`);
    if (direct.test(line)) uses.push({ kind: 'call', symbol: baseName });
    if (uses.length > 0) return uses;

    // Value uses such as `router.get('/x', handler)`; skip type positions in TS
    const reference = isPython
      ? new RegExp(`(?<![\\w.])${local}(?![\\w])`)
      : new RegExp(`(?<!(?:[:<|&]|\\bas|\\bextends|\\bimplements|\\btypeof|\\bkeyof)\\s*)(?<![\\w$.])${local}(?![\\w$])`);
    if (reference.test(line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""'))) {
      uses.push({ kind: 'reference', symbol: baseName });
    }
    return uses;
  }

  /**
   * Name of the function or method containing a line (`Class.method` inside classes), or undefined at module level.
   */
  public static enclosingSymbol(lines: string[], lineIdx: number, isPython: boolean = false): string | undefined {
    return isPython ? this.enclosingPython(lines, lineIdx) : this.enclosingJs(lines, lineIdx);
  }

  private static enclosingJs(lines: string[], lineIdx: number): string | undefined {
    for (let d = lineIdx; d >= 0; d--) {
      const decl = this.jsDeclaration(lines[d]);
      if (!decl) continue;
      if (d !== lineIdx && this.blockClosedBefore(lines, d, lineIdx)) continue;
      if (!decl.isMethod) return decl.name;
      for (let c = d - 1; c >= 0; c--) {
        const cls = lines[c].match(/\bclass\s+([\w$]+)/);
        if (cls) return `${cls[1]}.${decl.name}`;
      }
      return decl.name;
    }
    return this.registeredCallback(lines, lineIdx);
  }

  /**
   * Names an anonymous callback after what registered it: `command flow` for commander CLIs,
   * `GET /api/keys` for Express-style routes.
   */
  private static registeredCallback(lines: string[], lineIdx: number): string | undefined {
    for (let d = lineIdx; d >= Math.max(0, lineIdx - 80); d--) {
      const command = lines[d].match(/\.command\(\s*['"`]([^'"`\s]+)/);
      const route = lines[d].match(/\b(?:app|router|server)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)/i);
      if (!command && !route) continue;
      // The callback block usually opens a few lines below the registration (`.command('x')...action(() => {`)
      if (d !== lineIdx && this.blockClosedBefore(lines, d, lineIdx, false)) continue;
      return command ? `command ${command[1]}` : `${route![1].toUpperCase()} ${route![2]}`;
    }
    return undefined;
  }

  private static jsDeclaration(line: string): { name: string; isMethod: boolean } | null {
    const fn = line.match(/\bfunction\s*\*?\s*([\w$]+)\s*\(/)
      || line.match(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+)?=>)/);
    if (fn) return { name: fn[1], isMethod: false };
    // With a modifier keyword the parameter list may continue on later lines; without one, require
    // `name(...) {` on one line so a bare call statement like `doThing(x)` is not mistaken for a method
    const method = line.match(/^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)+([\w$]+)\s*(?:<[^>]*>)?\s*\(/)
      || line.match(/^\s*([\w$]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/);
    if (method && !NOT_FUNCTION_NAMES.has(method[1])) return { name: method[1], isMethod: true };
    return null;
  }

  // True when the block opened at or after `declLine` closes before `targetLine`
  private static blockClosedBefore(lines: string[], declLine: number, targetLine: number, isDeclaration: boolean = true): boolean {
    let depth = 0;
    let opened = false;
    for (let i = declLine; i < targetLine; i++) {
      const code = lines[i].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
      for (const ch of code) {
        if (ch === '{') { depth++; opened = true; }
        else if (ch === '}') depth--;
      }
      if (opened && depth <= 0) return true;
      // A one-line arrow function (`const f = (x) => x + 1;`) never opens a block and ends on its own line
      if (isDeclaration && i === declLine && !opened && !/(?:[({,]|=>)\s*$/.test(code)) return true;
    }
    return false;
  }

  private static enclosingPython(lines: string[], lineIdx: number): string | undefined {
    const indentOf = (l: string) => l.match(/^\s*/)![0].length;
    let currentIndent = indentOf(lines[lineIdx]);
    let fnName: string | undefined;
    for (let d = lineIdx - 1; d >= 0; d--) {
      if (!lines[d].trim()) continue;
      const indent = indentOf(lines[d]);
      if (indent >= currentIndent) continue;
      currentIndent = indent;
      const def = lines[d].match(/^\s*(?:async\s+)?def\s+(\w+)/);
      const cls = lines[d].match(/^\s*class\s+(\w+)/);
      if (def && !fnName) fnName = def[1];
      else if (cls) return fnName ? `${cls[1]}.${fnName}` : cls[1];
      if (indent === 0) break;
    }
    return fnName;
  }

  /**
   * 1-based line where a symbol (or `Class.member`) is defined in a file's content.
   */
  public static findDefinitionLine(content: string, symbol: string): number | undefined {
    if (!content) return undefined;
    const lines = content.split(/\r?\n/);
    const [owner, member] = symbol.includes('.') ? symbol.split('.') : [symbol, undefined];
    const escape = (s: string) => s.replace(/[$]/g, '\\$');
    const ownerRegex = new RegExp(`(?:function\\s*\\*?|class|interface|type|enum|const|let|var|def)\\s+${escape(owner)}\\b|export\\s+default\\s+(?:async\\s+)?(?:function|class)\\s+${escape(owner)}\\b`);
    const ownerLine = lines.findIndex(l => ownerRegex.test(l));
    if (member) {
      const memberRegex = new RegExp(`^\\s*(?:(?:public|private|protected|static|async|override|get|set)\\s+)*(?:def\\s+)?${escape(member)}\\s*(?:<[^>]*>)?\\(|\\b${escape(member)}\\s*[:=]\\s*(?:async\\s+)?(?:function|\\()`);
      const memberLine = lines.findIndex((l, i) => i >= Math.max(ownerLine, 0) && memberRegex.test(l));
      if (memberLine >= 0) return memberLine + 1;
    }
    return ownerLine >= 0 ? ownerLine + 1 : undefined;
  }
}
