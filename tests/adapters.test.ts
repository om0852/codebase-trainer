import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { CallSiteExtractor, FlowEdge } from '../src/flow/callSites.js';
import { ContractDriftDetector } from '../src/microservices/contractDrift.js';
import { ImportResolver } from '../src/graph/importResolver.js';
import { withFixture } from './helpers.js';

// Framework adapters read syntax-tree facts; they are skipped under CODEBASE_TRAINER_PARSER=regex
const skip = !TreeSitter.isReady() && 'tree-sitter disabled (CODEBASE_TRAINER_PARSER=regex)';

const edgesOf = (root: string) => CallSiteExtractor.extractEdges(root, ASTExtractor.scanDirectory(root));
const describe = (e: FlowEdge) => `${e.kind}:${e.from.filePath}#${e.from.symbol}->${e.to.filePath}#${e.to.symbol}@${e.to.line}${e.label ? ` [${e.label}]` : ''}`;

test('Prisma schemas are indexed and client calls link to models', { skip }, async () => {
  await withFixture({
    'prisma/schema.prisma': 'model User {\n  id String @id\n}\n\nmodel ApiKey {\n  id String @id\n}\n',
    'lib/db.ts': "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\n",
    'app/api/keys/[id]/route.ts': [
      "import { db } from '../../../../lib/db';",
      'export async function DELETE() {',
      '  await db.apiKey.delete({ where: { id: "1" } });',
      '  const n = db.apiKey.fields;',
      '  return new Response(null);',
      '}'
    ].join('\n')
  }, root => {
    const schema = ASTExtractor.scanDirectory(root).find(f => f.filePath.endsWith('schema.prisma'));
    assert.deepEqual(schema?.symbols, ['User', 'ApiKey']);
    const data = edgesOf(root).filter(e => e.kind === 'data').map(describe);
    assert.deepEqual(data, ['data:app/api/keys/[id]/route.ts#DELETE->prisma/schema.prisma#ApiKey@5 [delete ApiKey]']);
    assert.ok(!edgesOf(root).some(e => e.to.symbol === 'db.apiKey'), '`db.apiKey.delete()` is not a call to something lib/db defines');
  });
});

test('dependency injection: services through constructor types, TypeORM repositories as data edges', { skip }, async () => {
  await withFixture({
    'src/keys/keys.controller.ts': [
      "import { Controller, Delete, Param } from '@nestjs/common';",
      "import { KeysService } from './keys.service';",
      "@Controller('keys')",
      'export class KeysController {',
      '  constructor(private readonly keysService: KeysService) {}',
      "  @Delete(':id')",
      "  remove(@Param('id') id: string) {",
      '    return this.keysService.revoke(id);',
      '  }',
      '}'
    ].join('\n'),
    'src/keys/keys.service.ts': [
      "import { InjectRepository } from '@nestjs/typeorm';",
      "import { Repository } from 'typeorm';",
      "import { KeyEntity } from './key.entity';",
      'export class KeysService {',
      '  constructor(@InjectRepository(KeyEntity) private readonly keyRepository: Repository<KeyEntity>) {}',
      '  async revoke(id: string) {',
      '    return this.keyRepository.delete(id);',
      '  }',
      '}'
    ].join('\n'),
    'src/keys/key.entity.ts': "import { Entity } from 'typeorm';\n@Entity()\nexport class KeyEntity {}\n",
    'src/main.ts': "import { NestFactory } from '@nestjs/core';\nasync function bootstrap() {\n  const app = await NestFactory.create({});\n  app.setGlobalPrefix('api');\n}\n"
  }, root => {
    const edges = edgesOf(root).map(describe);
    assert.ok(edges.includes('call:src/keys/keys.controller.ts#KeysController.remove->src/keys/keys.service.ts#KeysService.revoke@6'), edges.join('\n'));
    assert.ok(edges.includes('data:src/keys/keys.service.ts#KeysService.revoke->src/keys/key.entity.ts#KeyEntity@3 [delete KeyEntity]'), edges.join('\n'));

    const routes = ContractDriftDetector.extractServerEndpoints(root).map(e => `${e.method} ${e.endpoint} ${e.filePath.replace(/\\/g, '/')}:${e.line}`);
    assert.deepEqual(routes, ['DELETE /api/keys/:id src/keys/keys.controller.ts:7'], 'NestJS decorators plus the global prefix make a route');
  });
});

test('routes from FastAPI, Flask and multi-line Express definitions', { skip }, async () => {
  await withFixture({
    'api/items.py': 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/v1")\n\n@router.post("/items")\ndef create_item():\n    return {}\n',
    'web/app.py': 'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/legacy", methods=["POST", "PUT"])\ndef legacy():\n    return ""\n',
    'server/routes.ts': "import { Router } from 'express';\nconst router = Router();\nrouter.get(\n  '/articles/feed',\n  (req, res) => res.json([])\n);\nexport default router;\n"
  }, root => {
    const routes = ContractDriftDetector.extractServerEndpoints(root).map(e => `${e.method} ${e.endpoint}`).sort();
    assert.deepEqual(routes, ['GET /articles/feed', 'POST /legacy', 'POST /v1/items', 'PUT /legacy']);
  });
});

test('tRPC client calls link to procedures, which link to Drizzle tables', { skip }, async () => {
  await withFixture({
    'packages/api/src/root.ts': "import { keyRouter } from './router/key';\nexport const appRouter = createTRPCRouter({\n  key: keyRouter,\n});\n",
    'packages/api/src/router/key.ts': [
      "import { Key } from '../schema';",
      'export const keyRouter = {',
      '  list: publicProcedure.query(({ ctx }) => ctx.db.query.Key.findMany()),',
      '  revoke: protectedProcedure',
      '    .input(z.string())',
      '    .mutation(({ ctx, input }) => {',
      '      return ctx.db.delete(Key).where(eq(Key.id, input));',
      '    }),',
      '};'
    ].join('\n'),
    'packages/api/src/schema.ts': "export const Key = pgTable('key', (t) => ({ id: t.uuid() }));\n",
    'apps/web/src/keys.tsx': [
      'export function Keys() {',
      '  const keys = useQuery(trpc.key.list.queryOptions());',
      '  const revoke = useMutation(trpc.key.revoke.mutationOptions());',
      '  queryClient.invalidateQueries(trpc.key.list.queryFilter());',
      '  return null;',
      '}'
    ].join('\n')
  }, root => {
    const edges = edgesOf(root).filter(e => e.kind === 'http' || e.kind === 'data').map(describe).sort();
    assert.deepEqual(edges, [
      'data:packages/api/src/router/key.ts#keyRouter.list->packages/api/src/schema.ts#Key@1 [findMany Key]',
      'data:packages/api/src/router/key.ts#keyRouter.revoke->packages/api/src/schema.ts#Key@1 [delete Key]',
      'http:apps/web/src/keys.tsx#Keys->packages/api/src/router/key.ts#keyRouter.list@3 [tRPC key.list]',
      'http:apps/web/src/keys.tsx#Keys->packages/api/src/router/key.ts#keyRouter.revoke@4 [tRPC key.revoke]'
    ], 'queryFilter only references a procedure, so it is not a request');
  });
});

test('fetch wrappers and axios instances are client requests linked to route handlers', { skip }, async () => {
  await withFixture({
    'lib/api.ts': [
      "import axios from 'axios';",
      "const BASE = '';",
      'export async function apiFetch(path: string, init?: RequestInit) {',
      '  return fetch(`${BASE}${path}`, init);',
      '}',
      "export const api = axios.create({ baseURL: '/api' });"
    ].join('\n'),
    'components/keys.tsx': [
      "import { apiFetch, api } from '../lib/api';",
      'export function KeyRow({ id }: { id: string }) {',
      '  async function onRevoke() {',
      "    await apiFetch(`/api/keys/${id}`, { method: 'DELETE' });",
      '  }',
      '  async function onCreate() {',
      "    await api.post('/keys', { name: 'x' });",
      '  }',
      '  return null;',
      '}'
    ].join('\n'),
    'app/api/keys/[id]/route.ts': 'export async function DELETE() { return new Response(null); }\n',
    'app/api/keys/route.ts': 'export async function POST() { return new Response(null); }\n'
  }, root => {
    const calls = ContractDriftDetector.extractClientCalls(root).map(c => `${c.method} ${c.endpoint} ${c.filePath.replace(/\\/g, '/')}:${c.line}`).sort();
    assert.deepEqual(calls, ['DELETE /api/keys/${id} components/keys.tsx:4', 'POST /api/keys components/keys.tsx:7']);
    const http = edgesOf(root).filter(e => e.kind === 'http').map(e => `${e.from.symbol}->${e.to.filePath}#${e.to.symbol} [${e.label}]`).sort();
    assert.deepEqual(http, [
      'onCreate->app/api/keys/route.ts#POST [POST /api/keys]',
      'onRevoke->app/api/keys/[id]/route.ts#DELETE [DELETE /api/keys/[id]]'
    ]);
  });
});

test('monorepo workspace packages resolve through package.json exports', async () => {
  await withFixture({
    'packages/db/package.json': JSON.stringify({ name: '@acme/db', exports: { '.': './src/index.ts', './schema': { types: './dist/schema.d.ts', default: './src/schema.ts' } } }),
    'packages/db/src/index.ts': 'export const db = 1;\n',
    'packages/db/src/schema.ts': 'export const Post = 1;\n',
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { './*': './src/*.tsx' } }),
    'packages/ui/src/button.tsx': 'export const Button = () => null;\n',
    'apps/web/page.ts': "import { db } from '@acme/db';\nimport { Post } from '@acme/db/schema';\nimport { Button } from '@acme/ui/button';\nimport React from 'react';\n"
  }, root => {
    const graph = ImportResolver.buildImportGraph(root, ASTExtractor.scanDirectory(root));
    const page = path.join(root, 'apps', 'web', 'page.ts');
    const targets = graph[page].map(t => path.relative(root, t).replace(/\\/g, '/')).sort();
    assert.deepEqual(targets, ['packages/db/src/index.ts', 'packages/db/src/schema.ts', 'packages/ui/src/button.tsx']);
  });
});
