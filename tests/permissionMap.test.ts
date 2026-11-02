import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { PermissionMapBuilder, RoutePermission } from '../src/security/permissionMap.js';
import { DiffChecker } from '../src/review/diffChecker.js';
import { DiffParser } from '../src/review/diffParser.js';
import { withFixture } from './helpers.js';

// NestJS routes come from decorators, which need syntax-tree facts
const skip = !TreeSitter.isReady() && 'tree-sitter disabled (CODEBASE_TRAINER_PARSER=regex)';

const routeOf = (routes: RoutePermission[], method: string, endpoint: string) => {
  const route = routes.find(r => r.method === method && r.endpoint === endpoint);
  assert.ok(route, `${method} ${endpoint} is mapped: ${routes.map(r => `${r.method} ${r.endpoint}`).join(', ')}`);
  return route!;
};

// The bug that motivated the permission map: deleting a link needs only `links:write`, the edit scope
const linksApp: Record<string, string> = {
  'lib/auth.ts': 'export const withScope = (scope: string, handler: Function) => handler;\n',
  'app/api/links/route.ts': [
    "import { withScope } from '../../../lib/auth';",
    "export const GET = withScope('links:read', async () => Response.json([]));",
    "export const POST = withScope('links:write', async (req: Request) => Response.json(await req.json()));"
  ].join('\n'),
  'app/api/links/[id]/route.ts': [
    "import { withScope } from '../../../../lib/auth';",
    "import { db } from '../../../../lib/db';",
    "export const PATCH = withScope('links:write', async (req: Request) => {",
    '  return Response.json(await db.link.update({ where: { id: "1" }, data: await req.json() }));',
    '});',
    '',
    "export const DELETE = withScope('links:write', async () => {",
    '  await db.link.delete({ where: { id: "1" } });',
    '  return new Response(null, { status: 204 });',
    '});'
  ].join('\n'),
  'lib/db.ts': 'export const db: any = {};\n'
};

test('permission map: a delete allowed by the edit scope is flagged', async () => {
  await withFixture(linksApp, root => {
    const map = PermissionMapBuilder.build(root);
    const del = routeOf(map.routes, 'DELETE', '/api/links/[id]');
    assert.equal(del.auth, 'required');
    assert.deepEqual(del.scopes, ['links:write']);
    assert.ok(del.destructive);
    assert.deepEqual(routeOf(map.routes, 'GET', '/api/links').scopes, ['links:read']);

    const finding = map.findings.find(f => f.rule === 'method-scope-mismatch');
    assert.ok(finding, `flagged: ${JSON.stringify(map.findings)}`);
    assert.equal(finding.endpoint, '/api/links/[id]');
    assert.equal(finding.severity, 'info', 'no stronger delete scope elsewhere, so this is a question, not a warning');
    assert.ok(finding.evidence.some(e => e.startsWith('PATCH /api/links/[id]')), 'cites the edit route sharing the scope');
  });
});

test('permission map: the same delete is a warning when other deletes use a delete scope', async () => {
  await withFixture({
    ...linksApp,
    'app/api/keys/[id]/route.ts': [
      "import { withScope } from '../../../../lib/auth';",
      "export const DELETE = withScope('keys:delete', async () => new Response(null, { status: 204 }));"
    ].join('\n')
  }, root => {
    const findings = PermissionMapBuilder.build(root).findings.filter(f => f.rule === 'method-scope-mismatch');
    assert.equal(findings.length, 1, JSON.stringify(findings));
    assert.equal(findings[0].severity, 'warning');
    assert.ok(findings[0].evidence.some(e => e.includes('keys:delete')));
  });
});

test('permission map: Express middleware, unguarded writes and read scopes on writes', async () => {
  await withFixture({
    'src/routes/notes.ts': [
      "import { Router } from 'express';",
      "import { requireAuth, requireScope } from '../auth';",
      'const router = Router();',
      "router.get('/notes', requireAuth, async (req, res) => res.json([]));",
      "router.post('/notes', requireAuth, async (req, res) => res.json(req.body));",
      "router.delete('/notes/:id', async (req, res) => {",
      '  res.status(204).end();',
      '});',
      "router.post('/reports', requireScope('reports:read'), async (req, res) => res.json(req.body));",
      "router.post('/login', async (req, res) => res.json({}));",
      'export default router;'
    ].join('\n'),
    'src/auth.ts': 'export const requireAuth = () => {};\nexport const requireScope = (s: string) => () => {};\n'
  }, root => {
    const map = PermissionMapBuilder.build(root);
    assert.equal(routeOf(map.routes, 'POST', '/notes').auth, 'required');
    assert.equal(routeOf(map.routes, 'DELETE', '/notes/:id').auth, 'none');
    assert.equal(routeOf(map.routes, 'POST', '/login').auth, 'none');

    const rules = map.findings.map(f => `${f.rule} ${f.method} ${f.endpoint}`).sort();
    assert.deepEqual(rules, [
      'route-without-auth DELETE /notes/:id',
      'scope-name-mismatch POST /reports'
    ], 'sign-in routes are public by design');
  });
});

test('permission map: tRPC procedures and Next.js middleware matchers', async () => {
  await withFixture({
    'src/trpc.ts': [
      'export const publicProcedure = t.procedure;',
      'export const protectedProcedure = t.procedure.use(({ ctx, next }) => {',
      '  if (!ctx.session?.user) throw new TRPCError({ code: "UNAUTHORIZED" });',
      '  return next();',
      '});'
    ].join('\n'),
    'src/router/post.ts': [
      "import { protectedProcedure, publicProcedure } from '../trpc';",
      'export const postRouter = createTRPCRouter({',
      '  all: publicProcedure.query(({ ctx }) => ctx.db.post.findMany()),',
      '  delete: publicProcedure.input(z.string()).mutation(({ ctx, input }) => ctx.db.post.delete({ where: { id: input } })),',
      '  create: protectedProcedure.input(z.string()).mutation(({ ctx, input }) => ctx.db.post.create({ data: { title: input } })),',
      '});'
    ].join('\n'),
    'src/root.ts': "import { postRouter } from './router/post';\nexport const appRouter = createTRPCRouter({\n  post: postRouter,\n});\n",
    'middleware.ts': "export { default } from 'next-auth/middleware';\nexport const config = { matcher: ['/api/admin/:path*'] };\n",
    'app/api/admin/stats/route.ts': 'export async function GET() {\n  return Response.json({});\n}\n'
  }, root => {
    const map = PermissionMapBuilder.build(root);
    assert.equal(routeOf(map.routes, 'MUTATION', 'trpc:post.create').auth, 'required');
    assert.equal(routeOf(map.routes, 'QUERY', 'trpc:post.all').auth, 'none');
    assert.equal(routeOf(map.routes, 'GET', '/api/admin/stats').guards[0]?.kind, 'edge-middleware');
    assert.ok(map.findings.some(f => f.rule === 'route-without-auth' && f.endpoint === 'trpc:post.delete'), JSON.stringify(map.findings));
  });
});

test('permission map: NestJS guards, public decorators and module middleware', { skip }, async () => {
  await withFixture({
    'src/main.ts': "app.setGlobalPrefix('api');\n",
    'src/users/users.controller.ts': [
      "import { Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';",
      "@Controller('users')",
      'export class UsersController {',
      "  @Get('me')",
      '  me() { return {}; }',
      "  @Put('me')",
      '  update() { return {}; }',
      "  @Delete(':id')",
      "  @Roles('admin')",
      '  @UseGuards(JwtGuard, RolesGuard)',
      '  remove() { return {}; }',
      '}'
    ].join('\n'),
    'src/users/users.module.ts': [
      'export class UsersModule {',
      '  configure(consumer: MiddlewareConsumer) {',
      "    consumer.apply(AuthMiddleware).forRoutes({ path: 'users/me', method: RequestMethod.GET });",
      '  }',
      '}'
    ].join('\n')
  }, root => {
    const map = PermissionMapBuilder.build(root);
    const remove = routeOf(map.routes, 'DELETE', '/api/users/:id');
    assert.equal(remove.auth, 'required');
    assert.deepEqual(remove.roles, ['admin']);
    assert.equal(routeOf(map.routes, 'GET', '/api/users/me').guards[0]?.kind, 'module-middleware');
    assert.ok(map.findings.some(f => f.rule === 'route-without-auth' && f.method === 'PUT'), 'PUT /users/me is not in forRoutes');
  });
});

test('diff checker reports permission findings on changed route handlers only', async () => {
  await withFixture(linksApp, root => {
    const changed = DiffChecker.checkFiles(root, [DiffParser.asAddedFile('app/api/links/[id]/route.ts', linksApp['app/api/links/[id]/route.ts'])], 'test');
    const finding = changed.findings.find(f => f.ruleId === 'permission-mismatch');
    assert.ok(finding, JSON.stringify(changed.findings));
    assert.equal(finding.line, 7);
    assert.match(finding.message, /links:write/);

    const elsewhere = DiffChecker.checkFiles(root, [DiffParser.asAddedFile('lib/db.ts', linksApp['lib/db.ts'])], 'test');
    assert.ok(!elsewhere.findings.some(f => f.ruleId === 'permission-mismatch'));
  });
});
