import * as path from 'path';
import { ASTFact } from '../types/index.js';
import { CallFact, CodeFacts } from '../parsing/codeFacts.js';
import type { FlowEdge } from './callSites.js';

/**
 * Framework adapters: edges that plain imports and calls cannot express, such as a Prisma client call reaching a
 * model in `schema.prisma`. Each adapter reads syntax-tree facts and a repo-wide index built once per extraction.
 */

export interface ModelRef {
  filePath: string;
  symbol: string;
  line: number;
}

export interface RepoIndex {
  // Prisma client property name (`apiKey`) -> model declared in a .prisma schema (`ApiKey`)
  prismaModels: Map<string, ModelRef>;
  // tRPC procedure path (`post.create`) -> procedure definition (`postRouter.create`)
  trpcProcedures: Map<string, ModelRef>;
  // Drizzle table variable (`Post`) -> its `pgTable(...)` / `mysqlTable(...)` / `sqliteTable(...)` definition
  drizzleTables: Map<string, ModelRef>;
}

// Client operations that actually call a tRPC procedure (cache helpers such as `queryFilter` only reference it)
export const TRPC_REQUEST_OPERATIONS = new Set([
  'useQuery', 'useSuspenseQuery', 'useInfiniteQuery', 'useSuspenseInfiniteQuery', 'useMutation',
  'query', 'mutate', 'queryOptions', 'infiniteQueryOptions', 'mutationOptions', 'prefetch', 'prefetchInfinite',
  'fetch', 'fetchInfinite', 'ensureData'
]);

export interface AdapterContext {
  fact: ASTFact;
  tree: CodeFacts;
  lines: string[];
  fromRel: string;
  // The calling function for an edge, as the call-site extractor names it
  callerOf: (call: Pick<CallFact, 'enclosing' | 'outermost' | 'line'>) => { symbol?: string; within?: string };
  // Where an imported name comes from in this repo (null for packages), with a lookup for symbol lines there
  resolveLocal: (local: string) => { filePath: string; lineOf: (symbol: string) => number | undefined } | null;
}

// Generic wrappers whose type argument is the entity being queried (TypeORM, MikroORM, Mongoose)
const DATA_ACCESS_TYPE = /^(?:Repository|EntityRepository|MongoRepository|TreeRepository|Model)<([\w$]+)>$/;

const PRISMA_OPERATIONS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'create', 'createMany',
  'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy'
]);

export function buildRepoIndex(repoPath: string, facts: ASTFact[], read: (absPath: string) => string): RepoIndex {
  const toRel = (f: string) => path.relative(repoPath, f).replace(/\\/g, '/');
  const prismaModels = new Map<string, ModelRef>();
  facts.filter(f => f.language === 'prisma').forEach(f => {
    read(f.filePath).split(/\r?\n/).forEach((text, idx) => {
      const model = text.match(/^\s*(?:model|view)\s+([A-Za-z_]\w*)\s*\{/);
      // Prisma Client exposes model `ApiKey` as `prisma.apiKey`
      if (model) prismaModels.set(model[1][0].toLowerCase() + model[1].slice(1), { filePath: toRel(f.filePath), symbol: model[1], line: idx + 1 });
    });
  });
  const drizzleTables = new Map<string, ModelRef>();
  facts.filter(f => f.language === 'typescript' || f.language === 'javascript').forEach(f => {
    const content = read(f.filePath);
    if (!/(?:pg|mysql|sqlite)Table\s*\(/.test(content)) return;
    content.split(/\r?\n/).forEach((text, idx) => {
      const table = text.match(/^\s*(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:pg|mysql|sqlite)Table\s*\(/);
      if (table) drizzleTables.set(table[1], { filePath: toRel(f.filePath), symbol: table[1], line: idx + 1 });
    });
  });

  return { prismaModels, trpcProcedures: buildTrpcIndex(facts, read, toRel), drizzleTables };
}

/**
 * tRPC routers are object literals of procedures (`create: protectedProcedure...`), composed by key
 * (`createTRPCRouter({ post: postRouter })`). Walk from the root routers to give every procedure its client path.
 */
function buildTrpcIndex(facts: ASTFact[], read: (absPath: string) => string, toRel: (absPath: string) => string): Map<string, ModelRef> {
  interface RouterDef { filePath: string; line: number; procedures: Map<string, number>; children: Map<string, string> }
  const routers = new Map<string, RouterDef>();

  facts.filter(f => f.language === 'typescript' || f.language === 'javascript').forEach(f => {
    const content = read(f.filePath);
    if (!/Procedure\b|createTRPCRouter|\brouter\(/.test(content)) return;
    let current: RouterDef | null = null;
    content.split(/\r?\n/).forEach((text, idx) => {
      const declaration = text.match(/^\s*(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:(?:createTRPCRouter|t\.router|router|createRouter)\s*\()?\s*\{/);
      if (declaration) {
        current = { filePath: toRel(f.filePath), line: idx + 1, procedures: new Map(), children: new Map() };
        routers.set(declaration[1], current);
        return;
      }
      if (!current) return;
      const procedure = text.match(/^\s*([\w$]+)\s*:\s*[\w$.]*[pP]rocedure\b/);
      const child = text.match(/^\s*([\w$]+)\s*:\s*([\w$]+Router)\s*,?\s*$/);
      if (procedure) current.procedures.set(procedure[1], idx + 1);
      else if (child) current.children.set(child[1], child[2]);
    });
  });

  // Keep only real routers, and start from those no other router mounts
  [...routers.keys()].forEach(name => {
    const r = routers.get(name)!;
    if (r.procedures.size === 0 && r.children.size === 0) routers.delete(name);
  });
  const mounted = new Set([...routers.values()].flatMap(r => [...r.children.values()]));
  const roots = [...routers.keys()].filter(name => !mounted.has(name));

  const procedures = new Map<string, ModelRef>();
  const visit = (name: string, prefix: string[], depth: number) => {
    const router = routers.get(name);
    if (!router || depth > 8) return;
    router.procedures.forEach((line, proc) => {
      procedures.set([...prefix, proc].join('.'), { filePath: router.filePath, symbol: `${name}.${proc}`, line });
    });
    router.children.forEach((child, key) => visit(child, [...prefix, key], depth + 1));
  };
  roots.forEach(root => visit(root, [], 0));
  return procedures;
}

export function adapterEdges(ctx: AdapterContext, index: RepoIndex): FlowEdge[] {
  // One edge per (caller, target, label): repeated queries in the same function add nothing
  const unique = new Map<string, FlowEdge>();
  [...prismaEdges(ctx, index), ...drizzleEdges(ctx, index), ...injectionEdges(ctx), ...trpcEdges(ctx, index)].forEach(e => {
    const key = `${e.kind}|${e.from.symbol || ''}|${e.to.filePath}|${e.to.symbol || ''}|${e.label || ''}`;
    if (!unique.has(key)) unique.set(key, e);
  });
  return Array.from(unique.values());
}

/**
 * Drizzle queries: `db.insert(Post)`, `db.update(Post)`, `db.delete(Post)`, `db.select().from(Post)` pass the table;
 * `db.query.Post.findMany()` names it. Tables are matched by name against `pgTable(...)`-style definitions.
 */
function drizzleEdges(ctx: AdapterContext, index: RepoIndex): FlowEdge[] {
  if (index.drizzleTables.size === 0) return [];
  const edges: FlowEdge[] = [];
  const push = (call: CallFact, table: ModelRef, operation: string) => edges.push({
    kind: 'data',
    from: { filePath: ctx.fromRel, ...ctx.callerOf(call), line: call.line },
    to: { filePath: table.filePath, symbol: table.symbol, line: table.line },
    evidence: (ctx.lines[call.line - 1] || '').trim(),
    label: `${operation} ${table.symbol}`
  });

  ctx.tree.calls.forEach(call => {
    const parts = call.callee.split('.');
    const operation = parts[parts.length - 1];
    // Relational query API: `<db>.query.<table>.findMany()` / `.findFirst()`
    if (parts.length >= 3 && parts[parts.length - 3] === 'query' && ['findMany', 'findFirst'].includes(operation)) {
      const table = index.drizzleTables.get(parts[parts.length - 2]);
      if (table) push(call, table, operation);
      return;
    }
    if (!['insert', 'update', 'delete', 'from'].includes(operation)) return;
    // The table is passed as an argument on the same line
    ctx.tree.valueRefs.filter(ref => ref.line === call.line).forEach(ref => {
      const table = index.drizzleTables.get(ref.name);
      if (table) push(call, table, operation === 'from' ? 'select' : operation);
    });
  });
  return edges;
}

/**
 * tRPC client calls: `trpc.post.create.mutationOptions()`, `api.post.all.useQuery()`, `utils.post.byId.fetch()` ->
 * the `create` procedure of the router mounted at `post`, whatever the client variable is called.
 */
function trpcEdges(ctx: AdapterContext, index: RepoIndex): FlowEdge[] {
  if (index.trpcProcedures.size === 0) return [];
  const edges: FlowEdge[] = [];
  ctx.tree.calls.forEach(call => {
    const parts = call.callee.split('.');
    const operation = parts[parts.length - 1];
    if (parts.length < 3 || !TRPC_REQUEST_OPERATIONS.has(operation)) return;
    const procedurePath = parts.slice(1, -1).join('.');
    const procedure = index.trpcProcedures.get(procedurePath);
    if (!procedure || procedure.filePath === ctx.fromRel) return;
    edges.push({
      kind: 'http',
      from: { filePath: ctx.fromRel, ...ctx.callerOf(call), line: call.line },
      to: { filePath: procedure.filePath, symbol: procedure.symbol, line: procedure.line },
      evidence: (ctx.lines[call.line - 1] || '').trim(),
      label: `tRPC ${procedurePath}`
    });
  });
  return edges;
}

/**
 * Dependency injection (NestJS, Angular, any typed class): `this.articleService.favorite()` follows the declared
 * type of `articleService` to `ArticleService.favorite`; `this.articleRepository.findOne()` with type
 * `Repository<ArticleEntity>` is a data edge to the entity.
 */
function injectionEdges(ctx: AdapterContext): FlowEdge[] {
  if (ctx.tree.memberTypes.length === 0) return [];
  const types = new Map<string, string>();
  ctx.tree.memberTypes.forEach(m => types.set(`${m.className}.${m.property}`, m.type));

  const edges: FlowEdge[] = [];
  ctx.tree.calls.forEach(call => {
    const m = call.callee.match(/^this\.([\w$]+)\.([\w$]+)$/);
    const owner = (call.enclosing ?? call.outermost ?? '').split('.')[0];
    if (!m || !owner) return;
    const [, property, method] = m;
    const type = types.get(`${owner}.${property}`);
    if (!type) return;
    const caller = { filePath: ctx.fromRel, ...ctx.callerOf(call), line: call.line };
    const evidence = (ctx.lines[call.line - 1] || '').trim();

    const entity = type.match(DATA_ACCESS_TYPE)?.[1];
    if (entity) {
      const target = ctx.resolveLocal(entity);
      if (target) {
        edges.push({ kind: 'data', from: caller, to: { filePath: target.filePath, symbol: entity, line: target.lineOf(entity) }, evidence, label: `${method} ${entity}` });
      }
      return;
    }
    if (!/^[\w$]+$/.test(type)) return;
    const target = ctx.resolveLocal(type);
    if (target) {
      const symbol = `${type}.${method}`;
      edges.push({ kind: 'call', from: caller, to: { filePath: target.filePath, symbol, line: target.lineOf(symbol) ?? target.lineOf(type) }, evidence });
    }
  });
  return edges;
}

/**
 * `db.post.findMany(...)`, `prisma.apiKey.delete(...)`, `this.prisma.user.update(...)`, `tx.post.create(...)`:
 * a model property followed by a Prisma Client operation, whatever the client variable is called.
 */
function prismaEdges(ctx: AdapterContext, index: RepoIndex): FlowEdge[] {
  if (index.prismaModels.size === 0) return [];
  const edges: FlowEdge[] = [];
  ctx.tree.calls.forEach(call => {
    const parts = call.callee.split('.');
    for (let i = 1; i + 1 < parts.length; i++) {
      const model = index.prismaModels.get(parts[i]);
      if (!model || !PRISMA_OPERATIONS.has(parts[i + 1])) continue;
      edges.push({
        kind: 'data',
        from: { filePath: ctx.fromRel, ...ctx.callerOf(call), line: call.line },
        to: { filePath: model.filePath, symbol: model.symbol, line: model.line },
        evidence: (ctx.lines[call.line - 1] || '').trim(),
        label: `${parts[i + 1]} ${model.symbol}`
      });
      break;
    }
  });
  return edges;
}
