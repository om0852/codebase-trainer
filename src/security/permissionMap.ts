import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';
import { extractCodeFacts, SymbolFact } from '../parsing/codeFacts.js';
import { buildRepoIndex } from '../flow/adapters.js';
import { ContractDriftDetector, ServerEndpoint } from '../microservices/contractDrift.js';
import { ProjectConfigLoader } from '../config/projectConfig.js';

/**
 * Permission map: for every route, whether it requires a signed-in user and which scopes or roles it checks,
 * read from middleware, guard calls, decorators, NestJS module middleware, Next.js `middleware.ts` matchers and
 * tRPC procedure builders. Findings compare each route with its siblings. These are heuristics with evidence,
 * not a security audit: guards applied where a router is mounted, or decided at runtime, are not seen.
 */

export type AuthRequirement = 'required' | 'optional' | 'none';

export interface GuardEvidence {
  kind: 'middleware' | 'handler-check' | 'decorator' | 'module-middleware' | 'edge-middleware' | 'procedure';
  name: string;
  filePath: string;
  line: number;
}

export interface RoutePermission {
  // HTTP method, or QUERY / MUTATION for tRPC procedures
  method: string;
  // URL path, or `trpc:<router>.<procedure>`
  endpoint: string;
  filePath: string;
  line: number;
  // Last line of the handler (or of the route declaration when the handler is defined elsewhere)
  endLine: number;
  auth: AuthRequirement;
  scopes: string[];
  roles: string[];
  mutating: boolean;
  destructive: boolean;
  guards: GuardEvidence[];
}

export type PermissionRule = 'route-without-auth' | 'method-scope-mismatch' | 'scope-name-mismatch';

export interface PermissionFinding {
  rule: PermissionRule;
  severity: 'warning' | 'info';
  method: string;
  endpoint: string;
  filePath: string;
  line: number;
  message: string;
  // `METHOD endpoint (file:line) -> what guards it`, for the routes the finding compares against
  evidence: string[];
}

export interface PermissionMap {
  routes: RoutePermission[];
  findings: PermissionFinding[];
  summary: { routes: number; required: number; optional: number; none: number };
  notes: string[];
}

// Middleware and guard names that mean "a signed-in user is required"
const AUTH_NAME = /auth|login|logged|session|jwt|passport|guard|protect|permission|scope|role|admin|owner|access|acl|rbac|clerk|currentuser|requireuser/i;
const OPTIONAL_NAME = /optional|maybe|try|soft|public|anonymous/i;
// Calls that check a permission inside a handler: requireScope('links:write'), assertRole('admin'),
// verifyCurrentUserHasAccessToPost(id), withAuth(handler)
const GUARD_CALL = /^(?:[\w$]+\.)*(?:(?:require|assert|check|ensure|has|verify|enforce|authori[sz]e|can|with|must)\w*(?:Scope|Permission|Role|Access|Auth|Admin|Owner|User|Session|Login)\w*|authori[sz]e|authenticate|protect|isAuthenticated|isAdmin)$/i;
// Reads of the current user or session; with a 401/403 or redirect nearby they make the route require auth
const SESSION_READ = /\b(?:getServerSession|getSession|getServerAuthSession|currentUser|getCurrentUser|getAuth|getToken|validateRequest|requireUser|requireSession|auth)\s*\(|\b(?:req|request|ctx|context)\.(?:user|auth|session)\b/;
const REJECT = /status\s*[:(=]\s*40[13]\b|\b(?:Unauthori[sz]ed|Forbidden)(?:Exception|Error)?\b|\bredirect\s*\(|UNAUTHORIZED|FORBIDDEN|\bnotFound\s*\(/;
// Paths that are public by design: sign-in, webhooks, health checks
const PUBLIC_PATH = /(?:^|[/._:-])(?:login|logout|sign-?in|sign-?up|signout|register|auth|session|webhooks?|callback|oauth|health|healthz|status|ping|public|password|reset|verify|confirm|invite|unsubscribe|og)(?:$|[/._:-])/i;
const SCOPE_LITERAL = /^[a-z][\w-]*:[a-z*][\w*-]*$/i;
const READ_ACTION = /(?:^|[:._-])(?:read|view|list|get)$/i;
const STRONG_ACTION = /(?:^|[:._-])(?:delete|destroy|remove|admin|manage|owner|full|all|\*)$/i;
const DESTRUCTIVE_CALL = /(?<!(?:searchParams|headers|params|cookies|map|set|cache|query|url)\.)\b(?:delete|deleteMany|deleteOne|destroy|remove|softDelete|findOneAndDelete|findByIdAndDelete)\s*\(|\b(?:delete|remove|destroy)[A-Z]\w*\s*\(/;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'MUTATION']);

interface Call { name: string; args: string; line: number }

export class PermissionMapBuilder {
  // Project-specific guard names and public paths from codebase-trainer.yaml (`auth.guards`, `auth.publicPaths`)
  private static customGuards = new Set<string>();
  private static customPublic: RegExp[] = [];

  public static build(repoPath: string): PermissionMap {
    const { auth } = ProjectConfigLoader.load(repoPath);
    this.customGuards = new Set(auth.guards);
    this.customPublic = auth.publicPaths.map(p => ProjectConfigLoader.globToRegExp(p.replace(/^\//, '')));
    const facts = ASTExtractor.scanDirectory(repoPath);
    const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');
    const read = (f: string) => ASTExtractor.readSourceFile(f) ?? '';
    const notes = [
      'Heuristic: guards are read from route middleware, handler checks, decorators, NestJS module middleware, Next.js middleware.ts matchers and tRPC procedure builders. Guards applied where a router is mounted (`app.use("/admin", requireAdmin, router)`) or inside named handler functions defined elsewhere are not seen.',
      'Not a security audit: a route marked `required` checks for a signed-in user, not that the user may act on this record.'
    ];

    const endpoints = ContractDriftDetector.extractServerEndpoints(repoPath)
      .map(e => ({ ...e, filePath: e.filePath.replace(/\\/g, '/') }))
      .filter(e => !/(?:^|\/)(?:tests?|__tests__|spec|e2e)\//.test(e.filePath) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(e.filePath));
    const byFile = new Map<string, ServerEndpoint[]>();
    endpoints.forEach(e => byFile.set(e.filePath, [...(byFile.get(e.filePath) ?? []), e]));

    const routes: RoutePermission[] = [];
    byFile.forEach((fileEndpoints, rel) => {
      const content = read(path.join(repoPath, rel));
      const lines = content.split(/\r?\n/);
      const symbols = extractCodeFacts(path.join(repoPath, rel), content)?.symbols ?? [];
      const sorted = [...fileEndpoints].sort((a, b) => a.line - b.line);
      const routerGuards = this.routerLevelGuards(lines, rel);
      sorted.forEach((endpoint, i) => {
        const symbol = symbols.find(s => s.startLine === endpoint.line && s.kind !== 'class');
        const nextLine = sorted.slice(i + 1).find(e => e.line > endpoint.line)?.line ?? lines.length + 1;
        const endLine = symbol ? symbol.endLine : Math.min(nextLine - 1, endpoint.line + 80);
        const route = this.emptyRoute(endpoint.method, endpoint.endpoint, rel, endpoint.line, endLine);
        const body = lines.slice(endpoint.line - 1, endLine).join('\n');

        if (!symbol) this.expressMiddleware(route, body, rel, endpoint.line);
        routerGuards.filter(g => g.line < endpoint.line).forEach(g => this.addGuard(route, g, OPTIONAL_NAME.test(g.name) ? 'optional' : 'required'));
        if (symbol) this.decoratorGuards(route, symbol, symbols, rel);
        this.handlerChecks(route, body, rel, endpoint.line);
        route.destructive = route.method === 'DELETE' || DESTRUCTIVE_CALL.test(this.stripComments(body));
        routes.push(route);
      });
    });

    this.applyNestModuleMiddleware(routes, facts, read, toRel);
    this.applyNextMiddleware(routes, facts, read, toRel);
    routes.push(...this.trpcRoutes(repoPath, facts, read));
    routes.forEach(r => {
      r.mutating = MUTATING_METHODS.has(r.method) || r.destructive;
      r.scopes = [...new Set(r.scopes)];
      r.roles = [...new Set(r.roles)];
    });

    const summary = {
      routes: routes.length,
      required: routes.filter(r => r.auth === 'required').length,
      optional: routes.filter(r => r.auth === 'optional').length,
      none: routes.filter(r => r.auth === 'none').length
    };
    return { routes, findings: this.findings(routes), summary, notes };
  }

  /**
   * Findings, each comparing a route with the routes around it.
   */
  public static findings(routes: RoutePermission[]): PermissionFinding[] {
    const findings: PermissionFinding[] = [];
    const describe = (r: RoutePermission) => {
      const guard = r.auth === 'none' ? 'no guard' : [r.auth === 'optional' ? 'optional auth' : 'auth', ...r.scopes, ...r.roles.map(role => `role ${role}`)].join(', ');
      return `${r.method} ${r.endpoint} (${r.filePath}:${r.line}) -> ${guard}`;
    };
    const finding = (rule: PermissionRule, severity: PermissionFinding['severity'], r: RoutePermission, message: string, evidence: RoutePermission[]): PermissionFinding =>
      ({ rule, severity, method: r.method, endpoint: r.endpoint, filePath: r.filePath, line: r.line, message, evidence: evidence.slice(0, 5).map(describe) });

    const groups = new Map<string, RoutePermission[]>();
    routes.forEach(r => groups.set(this.resourceOf(r), [...(groups.get(this.resourceOf(r)) ?? []), r]));

    routes.forEach(route => {
      const siblings = (groups.get(this.resourceOf(route)) ?? []).filter(r => r !== route);

      // route-without-auth: a write with no guard next to guarded routes on the same resource
      if (route.auth === 'none' && route.mutating && !this.isPublicByDesign(route)) {
        const guarded = siblings.filter(r => r.auth === 'required');
        if (guarded.length > 0) {
          findings.push(finding('route-without-auth', 'warning', route,
            `${route.method} ${route.endpoint} has no auth guard, but ${guarded.length} other route(s) on the same resource require one.`, guarded));
        }
      }

      // scope-name-mismatch: a read scope guarding a handler that changes data
      const readScopes = route.scopes.filter(s => READ_ACTION.test(s));
      if (route.mutating && readScopes.length > 0 && readScopes.length === route.scopes.length) {
        findings.push(finding('scope-name-mismatch', 'warning', route,
          `${route.method} ${route.endpoint} changes data but is guarded only by read scope(s) ${readScopes.join(', ')}.`, []));
      }

      // method-scope-mismatch: a delete allowed by a scope that also grants editing
      if (route.destructive && route.scopes.length > 0 && !route.scopes.some(s => STRONG_ACTION.test(s)) && !route.roles.length) {
        const stronger = routes.filter(r => r !== route && r.destructive && r.scopes.some(s => STRONG_ACTION.test(s)));
        const sharedWithEdits = siblings.filter(r => r.mutating && !r.destructive && r.scopes.some(s => route.scopes.includes(s)));
        if (stronger.length > 0) {
          findings.push(finding('method-scope-mismatch', 'warning', route,
            `${route.method} ${route.endpoint} deletes data with only ${route.scopes.join(', ')}, while other deletes require a delete or admin scope.`, stronger));
        } else if (sharedWithEdits.length > 0) {
          findings.push(finding('method-scope-mismatch', 'info', route,
            `${route.scopes.join(', ')} allows deleting (${route.method} ${route.endpoint}) as well as editing. If edit and delete rights are granted separately, the delete needs its own scope.`, sharedWithEdits));
        }
      }
    });
    return findings;
  }

  /** Resource a route belongs to: `/api/v1/links/:id/tags` -> `link`, `trpc:post.delete` -> `trpc:post`. */
  private static resourceOf(route: RoutePermission): string {
    if (route.endpoint.startsWith('trpc:')) return route.endpoint.split('.').slice(0, -1).join('.') || route.endpoint;
    const segments = ContractDriftDetector.normalizePath(route.endpoint).split('/').filter(Boolean);
    const meaningful = segments.filter(s => s !== 'api' && !/^v\d+$/.test(s) && s !== '{id}' && s !== '{*}');
    // `/user` and `/users/:id` are the same resource
    return (meaningful[0] ?? '/').replace(/([^s])s$/, '$1');
  }

  /**
   * Middleware or decorator names that mean auth (or, with `customOnly`, only the project's own guard names from
   * codebase-trainer.yaml, for handler calls that the built-in GUARD_CALL pattern does not cover).
   */
  private static isGuardName(name: string, customOnly = false): boolean {
    const last = name.split('.').pop() ?? name;
    if (this.customGuards.has(name) || this.customGuards.has(last)) return true;
    return !customOnly && AUTH_NAME.test(name);
  }

  /** Sign-in, webhooks, health checks, and sign-up (`POST /users`) are public by design. */
  private static isPublicByDesign(route: RoutePermission): boolean {
    if (PUBLIC_PATH.test(route.endpoint)) return true;
    if (this.customPublic.some(re => re.test(route.endpoint.replace(/^\//, '')))) return true;
    return route.method === 'POST' && /\/(?:users|accounts|members|signup)$/i.test(ContractDriftDetector.normalizePath(route.endpoint));
  }

  private static emptyRoute(method: string, endpoint: string, filePath: string, line: number, endLine = line): RoutePermission {
    return { method, endpoint, filePath, line, endLine, auth: 'none', scopes: [], roles: [], mutating: false, destructive: false, guards: [] };
  }

  private static addGuard(route: RoutePermission, guard: GuardEvidence, auth: AuthRequirement): void {
    route.guards.push(guard);
    if (auth === 'required' || route.auth === 'none') route.auth = auth;
  }

  /** `router.post('/links', requireAuth, requireScope('links:write'), handler)`: every argument before the handler. */
  private static expressMiddleware(route: RoutePermission, body: string, rel: string, line: number): void {
    const open = body.indexOf('(');
    if (open < 0) return;
    const args = this.splitArgs(body, open);
    // First argument is the path, last is the handler
    args.slice(1, -1).forEach(arg => {
      const expression = arg.trim();
      if (/^(?:async\b|function\b|\()/.test(expression) || expression.includes('=>')) return;
      const names = expression.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
      names.forEach(name => {
        const callee = name.split('(')[0];
        if (!this.isGuardName(callee)) return;
        this.addGuard(route, { kind: 'middleware', name, filePath: rel, line }, OPTIONAL_NAME.test(callee) ? 'optional' : 'required');
        this.collectScopes(route, callee, name.slice(callee.length));
      });
    });
  }

  /** `router.use(requireAuth)` in a router file guards the routes declared after it. */
  private static routerLevelGuards(lines: string[], rel: string): GuardEvidence[] {
    const guards: GuardEvidence[] = [];
    lines.forEach((text, idx) => {
      const use = text.match(/\b(?:router|app|server|\w+Router)\.use\(\s*([^'"`\s][^)]*)\)/);
      if (!use) return;
      use[1].split(',').map(s => s.trim()).filter(name => this.isGuardName(name.split('(')[0]))
        .forEach(name => guards.push({ kind: 'middleware', name, filePath: rel, line: idx + 1 }));
    });
    return guards;
  }

  /** NestJS `@UseGuards(...)`, `@Roles(...)`, `@Public()` on the handler or its controller class. */
  private static decoratorGuards(route: RoutePermission, symbol: SymbolFact, symbols: SymbolFact[], rel: string): void {
    const className = symbol.qualifiedName.includes('.') ? symbol.qualifiedName.split('.')[0] : '';
    const cls = symbols.find(s => s.kind === 'class' && s.name === className);
    const decorators = [...(cls?.decorators ?? []), ...symbol.decorators];
    if (decorators.some(d => /^@(?:Public|SkipAuth|AllowAnonymous|Anonymous)\b/.test(d))) return;
    decorators.forEach(decorator => {
      const name = decorator.match(/^@([\w$.]+)/)?.[1] ?? '';
      const isGuard = /^(?:UseGuards|Auth|Authorized|Authenticated|Roles|Role|Scopes|Scope|Permissions|RequirePermissions|RequireScopes|Protected|Admin)$/.test(name)
        || (/^login_required$|^jwt_required$|requires?_|permission_required|^auth/.test(name.split('.').pop() ?? '') );
      if (!isGuard) return;
      const optional = /optional/i.test(decorator);
      this.addGuard(route, { kind: 'decorator', name: decorator.slice(0, 80), filePath: rel, line: symbol.startLine }, optional ? 'optional' : 'required');
      this.collectScopes(route, name, decorator.slice(name.length + 1));
    });
  }

  /** Guard calls and session checks inside the handler body. */
  private static handlerChecks(route: RoutePermission, body: string, rel: string, startLine: number): void {
    const code = this.stripComments(body);
    this.callsIn(code).forEach(call => {
      if (!GUARD_CALL.test(call.name) && !this.isGuardName(call.name, true)) return;
      this.addGuard(route, { kind: 'handler-check', name: `${call.name}(${call.args.slice(0, 60)})`, filePath: rel, line: startLine + call.line }, OPTIONAL_NAME.test(call.name) ? 'optional' : 'required');
      this.collectScopes(route, call.name, call.args);
    });
    for (const m of code.matchAll(/\brole\s*[!=]==?\s*['"`]([\w-]+)['"`]|\broles?\.includes\(\s*['"`]([\w-]+)['"`]/g)) route.roles.push(m[1] ?? m[2]);
    if (route.auth !== 'required' && SESSION_READ.test(code)) {
      const sessionLine = code.split('\n').findIndex(l => SESSION_READ.test(l));
      const rejects = REJECT.test(code);
      this.addGuard(route, { kind: 'handler-check', name: rejects ? 'session check with 401/403' : 'reads the session without rejecting', filePath: rel, line: startLine + Math.max(0, sessionLine) }, rejects ? 'required' : 'optional');
    }
  }

  /** Scope and role names from a guard's arguments: `requireScope('links:write')`, `@Roles('admin')`. */
  private static collectScopes(route: RoutePermission, name: string, args: string): void {
    // Only arguments that are themselves strings (or arrays of strings), not literals inside a wrapped handler
    const inner = args.trim().replace(/^\(([\s\S]*)\)$/, '$1');
    const literals = this.splitArgs(`(${inner})`, 0)
      .map(arg => arg.trim())
      .filter(arg => /^(?:\[\s*)?['"`]/.test(arg))
      .flatMap(arg => [...arg.matchAll(/['"`]([^'"`]+)['"`]/g)].map(m => m[1]));
    if (/role|admin/i.test(name)) route.roles.push(...literals.filter(l => /^[\w-]+$/.test(l)));
    else if (/scope|permission/i.test(name)) route.scopes.push(...literals.filter(l => /^[\w:.*-]+$/.test(l)));
    else route.scopes.push(...literals.filter(l => SCOPE_LITERAL.test(l)));
  }

  /**
   * NestJS `consumer.apply(AuthMiddleware).forRoutes({ path: 'articles', method: RequestMethod.POST }, ...)`.
   */
  private static applyNestModuleMiddleware(routes: RoutePermission[], facts: Array<{ filePath: string }>, read: (f: string) => string, toRel: (f: string) => string): void {
    facts.forEach(fact => {
      const content = read(fact.filePath);
      if (!content.includes('.forRoutes(')) return;
      for (const m of content.matchAll(/\.apply\(([^)]*)\)\s*(?:\.exclude\([\s\S]*?\)\s*)?\.forRoutes\(([\s\S]*?)\)\s*;/g)) {
        const middleware = m[1].split(',').map(s => s.trim()).filter(name => this.isGuardName(name));
        if (middleware.length === 0) continue;
        const line = content.slice(0, m.index).split('\n').length;
        const evidence: GuardEvidence = { kind: 'module-middleware', name: middleware.join(', '), filePath: toRel(fact.filePath), line };
        const targets = [...m[2].matchAll(/\{\s*path\s*:\s*['"`]([^'"`]*)['"`]\s*,\s*method\s*:\s*RequestMethod\.(\w+)/g)].map(t => ({ path: t[1], method: t[2] }));
        [...m[2].matchAll(/^\s*['"`]([^'"`]*)['"`]\s*$/gm)].forEach(t => targets.push({ path: t[1], method: 'ALL' }));
        const controllers = [...m[2].matchAll(/\b([A-Z]\w*Controller)\b/g)].map(c => c[1]);

        routes.forEach(route => {
          const routePath = ContractDriftDetector.normalizePath(route.endpoint);
          const matchesTarget = targets.some(t => {
            if (t.method !== 'ALL' && t.method !== route.method) return false;
            const target = ContractDriftDetector.normalizePath('/' + t.path.replace(/^\//, ''));
            const pattern = new RegExp(`(?:^|/)${target.replace(/^\//, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{id\\\}/g, '[^/]+').replace(/\*/g, '.*')}$`);
            return pattern.test(routePath);
          });
          const matchesController = controllers.some(c => this.declaresClass(route, c, read, toRel, facts));
          if (matchesTarget || matchesController) this.addGuard(route, evidence, 'required');
        });
      }
    });
  }

  private static declaresClass(route: RoutePermission, className: string, read: (f: string) => string, toRel: (f: string) => string, facts: Array<{ filePath: string }>): boolean {
    const fact = facts.find(f => toRel(f.filePath) === route.filePath);
    return !!fact && new RegExp(`class\\s+${className}\\b`).test(read(fact.filePath));
  }

  /** Next.js `middleware.ts` with an auth wrapper and a `matcher` list guards the paths it matches. */
  private static applyNextMiddleware(routes: RoutePermission[], facts: Array<{ filePath: string }>, read: (f: string) => string, toRel: (f: string) => string): void {
    const middleware = facts.find(f => /^(?:src\/)?middleware\.[cm]?[jt]s$/.test(toRel(f.filePath)));
    if (!middleware) return;
    const content = read(middleware.filePath);
    if (!/withAuth|clerkMiddleware|authMiddleware|getToken|\bauth\b|session/i.test(content)) return;
    const matcherBlock = content.match(/matcher\s*:\s*(\[[\s\S]*?\]|['"`][^'"`]+['"`])/)?.[1];
    const matchers = matcherBlock ? [...matcherBlock.matchAll(/['"`]([^'"`]+)['"`]/g)].map(m => m[1]) : ['/:path*'];
    // `/dashboard/:path*` matches /dashboard and everything below it; `:id` matches one segment
    const patterns = matchers.map(m => {
      try {
        return new RegExp('^' + m.split(/(\/:\w+\*|:\w+)/).map(part =>
          /^\/:\w+\*$/.test(part) ? '(?:/.*)?' : /^:\w+$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        ).join('') + '$');
      } catch {
        return null;
      }
    }).filter((p): p is RegExp => p !== null);
    const line = content.split('\n').findIndex(l => /withAuth|clerkMiddleware|authMiddleware|export\s+(?:default\s+)?(?:async\s+)?function/.test(l)) + 1;
    routes.filter(r => r.endpoint.startsWith('/') && patterns.some(p => p.test(r.endpoint)))
      .forEach(r => this.addGuard(r, { kind: 'edge-middleware', name: `middleware matcher ${matchers.join(', ')}`, filePath: toRel(middleware.filePath), line }, 'required'));
  }

  /** tRPC procedures: `delete: protectedProcedure.input(...).mutation(...)`. */
  private static trpcRoutes(repoPath: string, facts: Parameters<typeof buildRepoIndex>[1], read: (f: string) => string): RoutePermission[] {
    const procedures = buildRepoIndex(repoPath, facts, read).trpcProcedures;
    if (procedures.size === 0) return [];
    // Which procedure builders reject anonymous callers: `protectedProcedure = t.procedure.use(... UNAUTHORIZED ...)`
    const builderAuth = new Map<string, AuthRequirement>();
    facts.forEach(fact => {
      const content = read(fact.filePath);
      for (const m of content.matchAll(/(?:export\s+)?const\s+([\w$]*[pP]rocedure)\s*=([\s\S]{0,800}?)(?=\n(?:export\s+)?const\s|\n\/\*\*|$)/g)) {
        builderAuth.set(m[1], REJECT.test(m[2]) || /isAuthed|enforceUser|requireAuth/.test(m[2]) ? 'required' : 'none');
      }
    });

    const routes: RoutePermission[] = [];
    procedures.forEach((ref, procedurePath) => {
      const lines = read(path.join(repoPath, ref.filePath)).split(/\r?\n/);
      const builder = lines[ref.line - 1]?.match(/:\s*([\w$]*[pP]rocedure)\b/)?.[1] ?? '';
      let end = ref.line;
      while (end < lines.length && end < ref.line + 40 && !/^\s*[\w$]+\s*:\s*[\w$.]*[pP]rocedure\b/.test(lines[end])) end++;
      const body = lines.slice(ref.line - 1, end).join('\n');
      const kind = /\.mutation\s*\(/.test(body) ? 'MUTATION' : 'QUERY';
      const route = this.emptyRoute(kind, `trpc:${procedurePath}`, ref.filePath, ref.line, end);
      const auth = builderAuth.get(builder) ?? (/public/i.test(builder) ? 'none' : /protected|authed|private|admin|user|member|org|team/i.test(builder) ? 'required' : 'none');
      if (auth !== 'none') this.addGuard(route, { kind: 'procedure', name: builder, filePath: ref.filePath, line: ref.line }, auth);
      if (/admin/i.test(builder)) route.roles.push('admin');
      this.handlerChecks(route, body.split('\n').slice(1).join('\n'), ref.filePath, ref.line + 1);
      route.destructive = /^(?:delete|remove|destroy)/i.test(procedurePath.split('.').pop() ?? '') || DESTRUCTIVE_CALL.test(this.stripComments(body));
      routes.push(route);
    });
    return routes;
  }

  /** Top-level call arguments of the call whose `(` is at `open`. */
  private static splitArgs(text: string, open: number): string[] {
    const args: string[] = [];
    let depth = 0, quote = '', current = '';
    for (let i = open + 1; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        current += ch;
        if (ch === '\\') { current += text[++i] ?? ''; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue; }
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) {
        if (depth === 0) { args.push(current); return args; }
        depth--;
      }
      if (ch === ',' && depth === 0) { args.push(current); current = ''; continue; }
      current += ch;
    }
    args.push(current);
    return args;
  }

  /** Every call `name(args)` in the text, with its line offset. */
  private static callsIn(text: string): Call[] {
    const calls: Call[] = [];
    for (const m of text.matchAll(/(?<![\w$.])((?:[\w$]+\.)*[\w$]+)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const args = this.splitArgs(text, open).join(',');
      calls.push({ name: m[1], args, line: text.slice(0, m.index).split('\n').length - 1 });
    }
    return calls;
  }

  private static stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  }
}
