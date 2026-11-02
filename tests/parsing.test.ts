import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { extractCodeFacts } from '../src/parsing/codeFacts.js';
import { ASTExtractor } from '../src/extractors/astExtractor.js';
import { CallSiteExtractor } from '../src/flow/callSites.js';
import { ExecutionFlowTracer } from '../src/flow/executionFlow.js';
import { withFixture } from './helpers.js';

// These tests cover the tree-sitter path; they are skipped when the suite runs with CODEBASE_TRAINER_PARSER=regex
const skip = !TreeSitter.isReady() && 'tree-sitter disabled (CODEBASE_TRAINER_PARSER=regex)';

test('TypeScript facts: decorators, signatures, methods, exports, nested helpers', { skip }, () => {
  const facts = extractCodeFacts('keys.controller.ts', [
    "import { Controller, Delete, Param } from '@nestjs/common';",
    "import type { Key } from './key';",
    "import * as audit from './audit';",
    "@Controller('keys')",
    'export class KeysController {',
    "  @Delete(':id')",
    "  async remove(@Param('id') id: string): Promise<void> {",
    '    const toUpper = (s: string) => s.toUpperCase();',
    '    await this.service.revoke(toUpper(id));',
    '    audit.record(id);',
    '  }',
    '}',
    'export default function helper() { return 1; }'
  ].join('\n'))!;

  assert.ok(facts, 'TypeScript should parse');
  const cls = facts.symbols.find(s => s.name === 'KeysController')!;
  assert.deepEqual([cls.kind, cls.exported, cls.decorators], ['class', true, ["@Controller('keys')"]]);
  const method = facts.symbols.find(s => s.qualifiedName === 'KeysController.remove')!;
  assert.equal(method.kind, 'method');
  assert.deepEqual(method.decorators, ["@Delete(':id')"]);
  assert.equal(method.signature, "async remove(@Param('id') id: string): Promise<void>");
  assert.equal(facts.symbols.find(s => s.name === 'toUpper')!.nestedInFunction, true, 'Local helper is marked nested');
  assert.equal(method.nestedInFunction, false);
  assert.equal(facts.symbols.find(s => s.name === 'helper')!.isDefaultExport, true);

  const typeImport = facts.imports.find(i => i.specifier === './key')!;
  assert.equal(typeImport.bindings[0].typeOnly, true, '`import type` bindings are type-only');
  assert.deepEqual(facts.imports.find(i => i.specifier === './audit')!.bindings, [{ imported: '*', local: 'audit', typeOnly: false }]);

  const callees = facts.calls.filter(c => c.enclosing === 'KeysController.remove').map(c => c.callee).sort();
  assert.deepEqual(callees, ['audit.record', 'this.service.revoke', 'toUpper']);
});

test('JSX components are calls and nested handlers know their outer component', { skip }, () => {
  const facts = extractCodeFacts('form.tsx', [
    "import { Button } from './button';",
    'export function BillingForm() {',
    '  async function onSubmit() {',
    "    await fetch('/api/users/stripe');",
    '  }',
    '  return <form onSubmit={onSubmit}><Button /><div /></form>;',
    '}'
  ].join('\n'))!;
  const fetchCall = facts.calls.find(c => c.callee === 'fetch')!;
  assert.deepEqual([fetchCall.enclosing, fetchCall.outermost], ['onSubmit', 'BillingForm']);
  const jsx = facts.calls.filter(c => c.form === 'jsx').map(c => c.callee);
  assert.deepEqual(jsx, ['Button'], 'Components are calls; DOM tags like <div> are not');
  assert.ok(facts.valueRefs.some(r => r.name === 'onSubmit'), 'Handlers passed as JSX props are value references');
});

test('Python facts: decorated routes, methods and imports', { skip }, () => {
  const facts = extractCodeFacts('app.py', [
    'from .services import billing as bill',
    'import os',
    '',
    "@app.post('/keys')",
    'def create_key():',
    '    return bill.create()',
    '',
    'class Store:',
    '    def save(self):',
    '        self._write()',
    '    def _write(self):',
    '        pass'
  ].join('\n'))!;
  const route = facts.symbols.find(s => s.name === 'create_key')!;
  assert.deepEqual([route.kind, route.decorators, route.exported], ['function', ["@app.post('/keys')"], true]);
  assert.equal(facts.symbols.find(s => s.qualifiedName === 'Store.save')!.kind, 'method');
  assert.deepEqual(facts.imports.map(i => i.specifier), ['.services', 'os']);
  assert.deepEqual(facts.imports[0].bindings, [{ imported: 'billing', local: 'bill', typeOnly: false }]);
  assert.ok(facts.calls.some(c => c.callee === 'self._write' && c.enclosing === 'Store.save'));
});

test('extractor uses syntax-tree symbols and imports, including multi-line and require', { skip }, async () => {
  await withFixture({
    'src/a.ts': "import {\n  b,\n  c\n} from './b';\nconst legacy = require('./legacy');\nexport const run = async () => b(c);\n",
    'src/b.ts': 'export const b = (x: unknown) => x;\nexport const c = 1;\n',
    'src/legacy.js': 'module.exports = {};\n'
  }, root => {
    const fact = ASTExtractor.scanDirectory(root).find(f => f.filePath.endsWith('a.ts'))!;
    assert.deepEqual([...fact.importedModules].sort(), ['./b', './legacy']);
    assert.ok(fact.symbols?.includes('run'));
  });
});

test('same-file calls become flow edges; local helpers do not', { skip }, async () => {
  await withFixture({
    'src/service.ts': [
      'export class Service {',
      '  run() {',
      '    const fmt = (s: string) => s.trim();',
      "    this.load(fmt(' x '));",
      '    return prepare();',
      '  }',
      '  load(v: string) { return v; }',
      '}',
      'function prepare() { return 1; }'
    ].join('\n')
  }, root => {
    const edges = CallSiteExtractor.extractEdges(root, ASTExtractor.scanDirectory(root))
      .filter(e => e.from.filePath === e.to.filePath)
      .map(e => `${e.from.symbol}->${e.to.symbol}@${e.to.line}`)
      .sort();
    assert.deepEqual(edges, ['Service.run->Service.load@7', 'Service.run->prepare@9']);
  });
});

test('flow trace orders a nested handler\'s request under its component', { skip }, async () => {
  await withFixture({
    'app/settings/page.tsx': "import { KeysForm } from '../../components/keys-form';\nexport default function SettingsPage() {\n  return <KeysForm />;\n}\n",
    'components/keys-form.tsx': [
      'export function KeysForm() {',
      '  async function onRevoke() {',
      "    await fetch('/api/keys', { method: 'DELETE' });",
      '  }',
      '  return <button onClick={onRevoke}>Revoke key</button>;',
      '}'
    ].join('\n'),
    'app/api/keys/route.ts': "import { revokeKey } from '../../../lib/keys';\nexport async function DELETE() {\n  await revokeKey();\n  return new Response(null);\n}\n",
    'lib/keys.ts': 'export async function revokeKey() { return true; }\n'
  }, root => {
    const flow = ExecutionFlowTracer.traceFlow(root, 'revoke key');
    const order = flow.edges.map(e => `${e.from.symbol}->${e.to.symbol}`);
    assert.deepEqual(order, ['SettingsPage->KeysForm', 'onRevoke->DELETE', 'DELETE->revokeKey'], `Unexpected order: ${order.join(' | ')}`);
  });
});
