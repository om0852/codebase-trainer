import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { ASTFact } from '../types/index.js';
import { extractCodeFacts } from '../parsing/codeFacts.js';
import { TreeSitter } from '../parsing/treeSitter.js';

export interface ClientCall {
  method: string;
  endpoint: string;
  filePath: string;
  line: number;
  payloadKeys: string[];
  queryKeys: string[];
}

export interface ServerEndpoint {
  method: string;
  endpoint: string;
  filePath: string;
  line: number;
  expectedBodyKeys: string[];
  expectedQueryKeys: string[];
}

export interface ContractDriftIssue {
  type: 'payload_mismatch' | 'missing_field' | 'dead_endpoint' | 'orphan_endpoint' | 'method_mismatch';
  severity: 'error' | 'warning' | 'info';
  endpoint: string;
  method: string;
  clientFile?: string;
  clientLine?: number;
  serverFile?: string;
  serverLine?: number;
  description: string;
  clientPayloadFields?: string[];
  serverExpectedFields?: string[];
  suggestedFix?: string;
}

export interface DriftReport {
  scannedClientCalls: number;
  scannedServerEndpoints: number;
  issues: ContractDriftIssue[];
  healthStatus: 'HEALTHY' | 'DRIFT_DETECTED' | 'CRITICAL_MISMATCH';
}

// Routes and client calls depend only on the files, so they are computed once per scanDirectory result (the same
// array until a file changes); callers get copies of the lists
const clientCallCache = new WeakMap<ASTFact[], { repoPath: string; value: ClientCall[] }>();
const endpointCache = new WeakMap<ASTFact[], { repoPath: string; value: ServerEndpoint[] }>();
function memoize<T>(cache: WeakMap<ASTFact[], { repoPath: string; value: T }>, facts: ASTFact[], repoPath: string, compute: () => T): T {
  const hit = cache.get(facts);
  if (hit && hit.repoPath === repoPath) return hit.value;
  const value = compute();
  cache.set(facts, { repoPath, value });
  return value;
}

export class ContractDriftDetector {
  /**
   * Scans codebase for frontend fetch/axios calls and extracts endpoints, methods, and payload shapes.
   */
  public static extractClientCalls(repoPath: string): ClientCall[] {
    const facts = ASTExtractor.scanDirectory(repoPath);
    return [...memoize(clientCallCache, facts, repoPath, () => this.computeClientCalls(repoPath, facts))];
  }

  private static computeClientCalls(repoPath: string, facts: ASTFact[]): ClientCall[] {
    const calls: ClientCall[] = [];

    facts.forEach(fact => {
      const content = ASTExtractor.readSourceFile(fact.filePath);
      if (content === null) return;

      const lines = content.split(/\r?\n/);
      const relPath = path.relative(repoPath, fact.filePath);

      lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

        // 1. fetch('/api/...')
        const fetchMatch = line.match(/fetch\s*\(\s*['"`]([^'"`]+)['"`](?:,\s*(\{[^}]*\}|[\w]+))?/);
        if (fetchMatch) {
          const endpoint = fetchMatch[1];
          if (endpoint.includes('...')) return;
          if (endpoint.startsWith('/') || endpoint.includes('api')) {
            const contextBlock = this.callArguments(lines, idx, line.indexOf('(', fetchMatch.index!));
            
            // Extract method
            const methodMatch = contextBlock.match(/method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/i);
            const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

            // Extract body keys
            const payloadKeys = this.extractKeysFromBody(contextBlock);
            const queryKeys = this.extractQueryKeys(endpoint);

            calls.push({
              method,
              endpoint: endpoint.split('?')[0],
              filePath: relPath,
              line: lineNum,
              payloadKeys,
              queryKeys
            });
          }
        }

        // 2. axios.post('/api/...', { ... }) / axios.get(...)
        const axiosMatch = line.match(/axios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/i);
        if (axiosMatch) {
          const method = axiosMatch[1].toUpperCase();
          const endpoint = axiosMatch[2];
          const contextBlock = this.callArguments(lines, idx, line.indexOf('(', axiosMatch.index!));
          const payloadKeys = method !== 'GET' ? this.extractKeysFromBody(contextBlock) : [];
          const queryKeys = this.extractQueryKeys(endpoint);

          calls.push({
            method,
            endpoint: endpoint.split('?')[0],
            filePath: relPath,
            line: lineNum,
            payloadKeys,
            queryKeys
          });
        }
      });
    });

    calls.push(...this.wrapperClientCalls(repoPath, facts, calls));
    return calls;
  }

  /**
   * Requests made through helpers rather than `fetch`/`axios` directly (needs tree-sitter):
   * - wrapper functions whose first parameter is passed into `fetch`/axios: `apiFetch('/api/keys', { method: 'DELETE' })`
   * - axios instances: `const api = axios.create({ baseURL: '/api' })` then `api.delete('/keys/1')`
   * Wrappers and instances are matched by name across the repo.
   */
  private static wrapperClientCalls(repoPath: string, facts: Array<{ filePath: string }>, existing: ClientCall[]): ClientCall[] {
    const VERBS = ['get', 'post', 'put', 'patch', 'delete'];
    const wrappers = new Map<string, string | null>(); // name -> fixed method (or null: read from options)
    const instances = new Map<string, string>();       // axios instance variable -> baseURL ('' when absolute/unknown)
    const sources: Array<{ rel: string; content: string; lines: string[]; facts: NonNullable<ReturnType<typeof extractCodeFacts>> }> = [];

    facts.forEach(fact => {
      const content = ASTExtractor.readSourceFile(fact.filePath);
      const tree = content ? extractCodeFacts(fact.filePath, content) : null;
      if (!content || !tree) return;
      const lines = content.split(/\r?\n/);
      sources.push({ rel: path.relative(repoPath, fact.filePath), content, lines, facts: tree });

      for (const m of content.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*axios\.create\(([^)]*)/g)) {
        const base = m[2].match(/baseURL\s*:\s*['"`]([^'"`]*)['"`]/)?.[1] ?? '';
        instances.set(m[1], base.startsWith('/') ? base : base.replace(/^https?:\/\/[^/]+/, ''));
      }
      tree.symbols.filter(s => s.kind === 'function' || s.kind === 'method').forEach(symbol => {
        const firstParam = symbol.signature.match(/\(\s*(?:\{[^}]*\}|[\w$]+)/)?.[0].replace(/^\(\s*/, '');
        if (!firstParam || firstParam.startsWith('{')) return;
        const passesParam = tree.calls.some(c =>
          c.enclosing === symbol.qualifiedName && /^(fetch|axios(\.\w+)?)$/.test(c.callee)
          && new RegExp(`\\b${firstParam.replace(/\$/g, '\\$')}\\b`).test(lines[c.line - 1] || ''));
        if (!passesParam) return;
        const verb = symbol.name.toLowerCase().match(/(get|post|put|patch|delete)$/)?.[1];
        wrappers.set(symbol.name, verb ? verb.toUpperCase() : null);
      });
    });
    if (wrappers.size === 0 && instances.size === 0) return [];

    const seen = new Set(existing.map(c => `${c.filePath}:${c.line}`));
    const results: ClientCall[] = [];
    sources.forEach(({ rel, lines, facts: tree }) => {
      tree.calls.forEach(call => {
        const url = call.firstStringArg;
        if (!url || !(url.startsWith('/') || url.includes('api')) || seen.has(`${rel}:${call.line}`)) return;
        let method: string | null = null;
        let endpoint = url;
        const [object, member] = call.callee.split('.');
        if (member && instances.has(object) && VERBS.includes(member.toLowerCase())) {
          method = member.toUpperCase();
          endpoint = (instances.get(object)!.replace(/\/$/, '') + '/' + url.replace(/^\//, '')).replace(/^([^/])/, '/$1');
        } else if (wrappers.has(call.callee)) {
          const block = this.callArguments(lines, call.line - 1, (lines[call.line - 1] || '').indexOf('('));
          method = wrappers.get(call.callee) ?? block.match(/method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/i)?.[1].toUpperCase() ?? 'GET';
        }
        if (!method) return;
        const block = this.callArguments(lines, call.line - 1, (lines[call.line - 1] || '').indexOf('('));
        results.push({
          method,
          endpoint: endpoint.split('?')[0],
          filePath: rel,
          line: call.line,
          payloadKeys: method !== 'GET' ? this.extractKeysFromBody(block) : [],
          queryKeys: this.extractQueryKeys(endpoint)
        });
        seen.add(`${rel}:${call.line}`);
      });
    });
    return results;
  }

  /**
   * Scans codebase for backend route definitions and expected payload / query parameters.
   */
  public static extractServerEndpoints(repoPath: string): ServerEndpoint[] {
    const facts = ASTExtractor.scanDirectory(repoPath);
    return [...memoize(endpointCache, facts, repoPath, () => this.computeServerEndpoints(repoPath, facts))];
  }

  private static computeServerEndpoints(repoPath: string, facts: ASTFact[]): ServerEndpoint[] {
    const endpoints: ServerEndpoint[] = [];
    // NestJS `app.setGlobalPrefix('api')` applies to every decorator route
    let globalPrefix = '';
    for (const fact of facts) {
      const match = (ASTExtractor.readSourceFile(fact.filePath) ?? '').match(/\.setGlobalPrefix\(\s*['"`]([^'"`]+)['"`]/);
      if (match) {
        globalPrefix = match[1];
        break;
      }
    }

    facts.forEach(fact => {
      const content = ASTExtractor.readSourceFile(fact.filePath);
      if (content === null) return;

      const lines = content.split(/\r?\n/);
      const relPath = path.relative(repoPath, fact.filePath);
      // These line patterns are for JavaScript; with a syntax tree, Python routes come from their decorators
      // (with router prefixes), so `@router.post("/items")` must not also match the Express pattern here
      const pythonFromDecorators = fact.filePath.endsWith('.py') && TreeSitter.isReady();

      lines.forEach((line, idx) => {
        if (pythonFromDecorators) return;
        const lineNum = idx + 1;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

        // Express / Fastify style: app.post('/api/domains', ...) or router.get(...)
        const routeMatch = line.match(/(?:app|router|server)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/i);
        if (routeMatch) {
          const method = routeMatch[1].toUpperCase();
          const routePath = routeMatch[2];
          if (routePath.includes('...')) return;
          const handlerBlock = lines.slice(idx, Math.min(lines.length, idx + 35)).join('\n');

          const expectedBodyKeys = this.extractExpectedBodyKeys(handlerBlock);
          const expectedQueryKeys = this.extractExpectedQueryKeys(handlerBlock);

          endpoints.push({
            method,
            endpoint: routePath,
            filePath: relPath,
            line: lineNum,
            expectedBodyKeys,
            expectedQueryKeys
          });
        }

        // Next.js App Router style: export async function POST(req) { ... }, or a wrapped handler
        // such as export const DELETE = withScope('links:write', async (req) => { ... })
        const nextMatch = line.match(/export\s+(?:(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(|const\s+(GET|POST|PUT|DELETE|PATCH)\s*=)/);
        if (nextMatch) {
          const normRel = relPath.replace(/\\/g, '/');
          if (!normRel.includes('api/') && !normRel.includes('routes/')) return;

          const method = (nextMatch[1] ?? nextMatch[2]).toUpperCase();
          // Infer endpoint from folder path e.g., app/api/v1/domains/route.ts -> /api/v1/domains
          let endpoint = normRel;
          if (endpoint.includes('api/')) {
            endpoint = '/' + endpoint.substring(endpoint.indexOf('api/'));
            // `.../route.tsx` and pages-router files such as `pages/api/keys.ts`
            endpoint = endpoint.replace(/\/route\.[cm]?[jt]sx?$/, '').replace(/\.[cm]?[jt]sx?$/, '');
          }

          const handlerBlock = lines.slice(idx, Math.min(lines.length, idx + 35)).join('\n');
          const expectedBodyKeys = this.extractExpectedBodyKeys(handlerBlock);
          const expectedQueryKeys = this.extractExpectedQueryKeys(handlerBlock);

          endpoints.push({
            method,
            endpoint,
            filePath: relPath,
            line: lineNum,
            expectedBodyKeys,
            expectedQueryKeys
          });
        }
      });

      endpoints.push(...this.decoratorEndpoints(fact.filePath, relPath, content, lines, globalPrefix));
    });

    return endpoints;
  }

  /**
   * Routes declared with decorators (needs tree-sitter): NestJS `@Controller('articles')` + `@Get(':slug')`,
   * FastAPI `@app.get('/items')` / `@router.post(...)` (with `APIRouter(prefix=...)`), and Flask
   * `@app.route('/x', methods=['POST'])` / blueprints.
   */
  private static decoratorEndpoints(absPath: string, relPath: string, content: string, lines: string[], globalPrefix: string): ServerEndpoint[] {
    const facts = extractCodeFacts(absPath, content);
    if (!facts) return [];
    const join = (...parts: string[]) => '/' + parts.map(p => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
    const firstString = (decorator: string) => decorator.match(/\(\s*(?:path\s*[:=]\s*)?['"`]([^'"`]*)['"`]/)?.[1] ?? '';
    const endpoint = (method: string, routePath: string, line: number): ServerEndpoint => {
      const handlerBlock = lines.slice(line - 1, Math.min(lines.length, line + 35)).join('\n');
      return {
        method,
        endpoint: routePath,
        filePath: relPath,
        line,
        expectedBodyKeys: this.extractExpectedBodyKeys(handlerBlock),
        expectedQueryKeys: this.extractExpectedQueryKeys(handlerBlock)
      };
    };
    const results: ServerEndpoint[] = [];

    if (facts.grammar === 'python') {
      // `router = APIRouter(prefix="/items")`; a file with one router applies its prefix to its routes
      const routerPrefix = content.match(/APIRouter\(\s*[^)]*prefix\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? '';
      facts.symbols.forEach(symbol => {
        symbol.decorators.forEach(decorator => {
          const fastApi = decorator.match(/^@\w+\.(get|post|put|patch|delete)\(/i);
          const flask = decorator.match(/^@\w+\.route\(/);
          if (fastApi) {
            const prefix = /^@router\./.test(decorator) ? routerPrefix : '';
            results.push(endpoint(fastApi[1].toUpperCase(), join(prefix, firstString(decorator)), symbol.startLine));
          } else if (flask) {
            const methods = decorator.match(/methods\s*=\s*\[([^\]]*)\]/)?.[1].match(/['"](\w+)['"]/g)?.map(m => m.slice(1, -1).toUpperCase()) ?? ['GET'];
            methods.forEach(method => results.push(endpoint(method, join(firstString(decorator)), symbol.startLine)));
          }
        });
      });
      return results;
    }

    // Express/Fastify/Koa routes written across lines (`router.get(\n  '/articles/feed', ...)`), from call facts
    facts.calls.forEach(call => {
      const verb = call.callee.match(/^(?:app|server|api|\w*[Rr]outer)\.(get|post|put|patch|delete|all)$/);
      if (verb && call.firstStringArg?.startsWith('/') && !lines[call.line - 1]?.includes(call.firstStringArg)) {
        results.push(endpoint(verb[1].toUpperCase(), call.firstStringArg, call.line));
      }
    });

    // NestJS: class prefix from @Controller, method routes from @Get/@Post/...
    const controllers = new Map<string, string>();
    facts.symbols.filter(s => s.kind === 'class').forEach(cls => {
      const controller = cls.decorators.find(d => /^@Controller\b/.test(d));
      if (controller) controllers.set(cls.name, firstString(controller));
    });
    facts.symbols.filter(s => s.kind === 'method').forEach(method => {
      const className = method.qualifiedName.split('.')[0];
      if (!controllers.has(className)) return;
      method.decorators.forEach(decorator => {
        const verb = decorator.match(/^@(Get|Post|Put|Patch|Delete|All)\b/);
        if (verb) results.push(endpoint(verb[1].toUpperCase(), join(globalPrefix, controllers.get(className)!, firstString(decorator)), method.startLine));
      });
    });
    return results;
  }

  /**
   * Compares client calls and server endpoints to detect schema drift, field mismatches, and dead endpoints.
   */
  public static detectDrift(repoPath: string): DriftReport {
    const clientCalls = this.extractClientCalls(repoPath);
    const serverEndpoints = this.extractServerEndpoints(repoPath);
    const issues: ContractDriftIssue[] = [];

    // Map server endpoints by normalized path + method
    const serverMap = new Map<string, ServerEndpoint>();
    serverEndpoints.forEach(ep => {
      const key = `${ep.method}:${this.normalizePath(ep.endpoint)}`;
      serverMap.set(key, ep);
    });

    const accessedServerKeys = new Set<string>();

    // 1. Analyze every client call against server endpoints
    clientCalls.forEach(call => {
      const normPath = this.normalizePath(call.endpoint);
      const exactKey = `${call.method}:${normPath}`;

      // Check if endpoint exists with different HTTP method
      const matchedEndpointAnyMethod = serverEndpoints.find(
        ep => this.normalizePath(ep.endpoint) === normPath
      );

      if (matchedEndpointAnyMethod && matchedEndpointAnyMethod.method !== call.method) {
        issues.push({
          type: 'method_mismatch',
          severity: 'error',
          endpoint: call.endpoint,
          method: call.method,
          clientFile: call.filePath,
          clientLine: call.line,
          serverFile: matchedEndpointAnyMethod.filePath,
          serverLine: matchedEndpointAnyMethod.line,
          description: `Client invokes [${call.method}] ${call.endpoint}, but server endpoint only accepts [${matchedEndpointAnyMethod.method}].`,
          suggestedFix: `Update client call in ${call.filePath}:${call.line} to use HTTP method ${matchedEndpointAnyMethod.method}.`
        });
        return;
      }

      const serverEp = serverMap.get(exactKey);

      if (!serverEp) {
        // Could be a dead endpoint or external API
        if (call.endpoint.startsWith('/api') || call.endpoint.startsWith('/v1') || call.endpoint.startsWith('/v2')) {
          issues.push({
            type: 'dead_endpoint',
            severity: 'error',
            endpoint: call.endpoint,
            method: call.method,
            clientFile: call.filePath,
            clientLine: call.line,
            description: `Client calls [${call.method}] \`${call.endpoint}\`, but no matching backend route handler exists.`,
            suggestedFix: `Verify route definition or register [${call.method}] ${call.endpoint} in backend API router.`
          });
        }
        return;
      }

      accessedServerKeys.add(exactKey);

      // 2. Validate Body / Payload Fields
      if (serverEp.expectedBodyKeys.length > 0 && call.payloadKeys.length > 0) {
        // Check for missing expected keys
        const missingOnClient = serverEp.expectedBodyKeys.filter(
          k => !call.payloadKeys.includes(k)
        );

        // Check for payload keys that do not match server expectations
        const extraOnClient = call.payloadKeys.filter(
          k => !serverEp.expectedBodyKeys.includes(k)
        );

        if (missingOnClient.length > 0 && extraOnClient.length > 0) {
          // Possible field rename / drift (e.g. client sends `hostname`, server expects `domain`)
          issues.push({
            type: 'payload_mismatch',
            severity: 'error',
            endpoint: call.endpoint,
            method: call.method,
            clientFile: call.filePath,
            clientLine: call.line,
            serverFile: serverEp.filePath,
            serverLine: serverEp.line,
            clientPayloadFields: call.payloadKeys,
            serverExpectedFields: serverEp.expectedBodyKeys,
            description: `API Contract Payload Drift: Client sends [${extraOnClient.join(', ')}] but backend route expects [${missingOnClient.join(', ')}].`,
            suggestedFix: `Synchronize payload fields: Align client \`${extraOnClient[0]}\` with backend \`${missingOnClient[0]}\`.`
          });
        } else if (missingOnClient.length > 0) {
          issues.push({
            type: 'missing_field',
            severity: 'warning',
            endpoint: call.endpoint,
            method: call.method,
            clientFile: call.filePath,
            clientLine: call.line,
            serverFile: serverEp.filePath,
            serverLine: serverEp.line,
            clientPayloadFields: call.payloadKeys,
            serverExpectedFields: serverEp.expectedBodyKeys,
            description: `Client payload is missing expected field(s): [${missingOnClient.join(', ')}].`,
            suggestedFix: `Pass [${missingOnClient.join(', ')}] in request body.`
          });
        }
      }
    });

    // 3. Scan for Orphan Routes (Routes defined on server, but unconsumed across codebase)
    serverEndpoints.forEach(ep => {
      const key = `${ep.method}:${this.normalizePath(ep.endpoint)}`;
      if (!accessedServerKeys.has(key)) {
        issues.push({
          type: 'orphan_endpoint',
          severity: 'info',
          endpoint: ep.endpoint,
          method: ep.method,
          serverFile: ep.filePath,
          serverLine: ep.line,
          description: `Orphan Endpoint: [${ep.method}] \`${ep.endpoint}\` is exposed but has 0 internal client consumers.`,
          suggestedFix: `If route is deprecated, consider archiving or adding automated test coverage.`
        });
      }
    });

    const hasErrors = issues.some(i => i.severity === 'error');
    const hasWarnings = issues.some(i => i.severity === 'warning');

    const healthStatus: DriftReport['healthStatus'] = hasErrors
      ? 'CRITICAL_MISMATCH'
      : hasWarnings
      ? 'DRIFT_DETECTED'
      : 'HEALTHY';

    // Save report to .codebase/contract_drift.json
    const outDir = path.join(repoPath, '.codebase');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'contract_drift.json'),
      JSON.stringify({ clientCalls, serverEndpoints, issues, healthStatus }, null, 2),
      'utf8'
    );

    return {
      scannedClientCalls: clientCalls.length,
      scannedServerEndpoints: serverEndpoints.length,
      issues,
      healthStatus
    };
  }

  // --- Helper Parsers ---

  /**
   * Text of a call's argument list, from the `(` at `openIndex` on line `lineIdx` to its matching `)`,
   * so method/body detection cannot read options from a neighbouring call.
   */
  private static callArguments(lines: string[], lineIdx: number, openIndex: number): string {
    let depth = 0;
    let quote: string | null = null;
    let out = '';
    for (let l = lineIdx; l < Math.min(lines.length, lineIdx + 40); l++) {
      const text = l === lineIdx ? lines[l].slice(openIndex) : lines[l];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        out += ch;
        if (quote) {
          if (ch === '\\') { out += text[++i] ?? ''; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return out;
      }
      out += ' ';
    }
    return out;
  }

  public static normalizePath(p: string): string {
    return p.toLowerCase()
      .replace(/^https?:\/\/[^/]+/, '')
      .split('?')[0]
      // Template-literal segments (`/api/keys/${id}`) are path params on the client side
      .replace(/\$\{[^}]+\}/g, '{id}')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '')
      .replace(/:\w+/g, '{id}')
      .replace(/\[\.{3}\w+\]/g, '{*}')
      .replace(/\[\w+\]/g, '{id}');
  }

  private static extractKeysFromBody(block: string): string[] {
    const keys: string[] = [];
    // e.g. JSON.stringify({ hostname, isCustom, userId: id })
    const bodyMatch = block.match(/(?:body\s*:\s*JSON\.stringify\s*\(\s*\{|post\s*\([^,]+,\s*\{)([^}]+)\}/);
    if (bodyMatch) {
      const inner = bodyMatch[1];
      inner.split(',').forEach(part => {
        const key = part.split(':')[0].trim().replace(/['"`]/g, '');
        if (/^[a-zA-Z0-9_$]+$/.test(key) && !['method', 'headers', 'mode', 'body'].includes(key)) {
          keys.push(key);
        }
      });
    }
    return keys;
  }

  private static extractQueryKeys(endpoint: string): string[] {
    if (!endpoint.includes('?')) return [];
    const queryPart = endpoint.split('?')[1];
    return queryPart.split('&').map(pair => pair.split('=')[0].trim()).filter(Boolean);
  }

  private static extractExpectedBodyKeys(block: string): string[] {
    const keys = new Set<string>();
    
    // const { a, b } = req.body / const { a, b } = await req.json()
    const destructureMatch = block.match(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(?:req\.body|await\s+req\.json\(\)|request\.body)/);
    if (destructureMatch) {
      destructureMatch[1].split(',').forEach(k => {
        const clean = k.split(':')[0].split('=')[0].trim();
        if (/^[a-zA-Z0-9_$]+$/.test(clean)) keys.add(clean);
      });
    }

    // req.body.x
    const dotMatches = block.matchAll(/req\.body\.([a-zA-Z0-9_$]+)/g);
    for (const m of dotMatches) {
      if (m[1]) keys.add(m[1]);
    }

    return Array.from(keys);
  }

  private static extractExpectedQueryKeys(block: string): string[] {
    const keys = new Set<string>();
    const destructureMatch = block.match(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*req\.query/);
    if (destructureMatch) {
      destructureMatch[1].split(',').forEach(k => {
        const clean = k.split(':')[0].trim();
        if (/^[a-zA-Z0-9_$]+$/.test(clean)) keys.add(clean);
      });
    }
    const dotMatches = block.matchAll(/req\.query\.([a-zA-Z0-9_$]+)/g);
    for (const m of dotMatches) {
      if (m[1]) keys.add(m[1]);
    }
    return Array.from(keys);
  }
}
