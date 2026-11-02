import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeSitter } from '../src/parsing/treeSitter.js';
import { FeatureSliceBuilder } from '../src/context/featureSlice.js';
import { withFixture } from './helpers.js';

// Data-layer edges (Prisma) come from syntax-tree facts; those checks are skipped under CODEBASE_TRAINER_PARSER=regex
const skip = !TreeSitter.isReady() && 'tree-sitter disabled (CODEBASE_TRAINER_PARSER=regex)';

// page -> store -> fetch wrapper -> route handler -> Prisma model, plus an unrelated module
const invoiceApp: Record<string, string> = {
  'app/invoices/page.tsx': [
    "import { useInvoiceStore } from '../../store/invoiceStore';",
    'export default function InvoicesPage() {',
    '  const { invoices } = useInvoiceStore();',
    '  return <ul>{invoices.map(i => <li key={i.id}>{i.total}</li>)}</ul>;',
    '}'
  ].join('\n'),
  'store/invoiceStore.ts': [
    "import { fetchInvoices } from '../lib/api';",
    'export function useInvoiceStore() {',
    '  const invoices: Array<{ id: string; total: number }> = [];',
    '  const loadInvoices = async () => invoices.push(...(await fetchInvoices()));',
    '  return { invoices, loadInvoices };',
    '}'
  ].join('\n'),
  'lib/api.ts': [
    'export async function fetchInvoices() {',
    "  const res = await fetch('/api/invoices');",
    '  return res.json();',
    '}'
  ].join('\n'),
  'lib/db.ts': "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\n",
  'app/api/invoices/route.ts': [
    "import { db } from '../../../lib/db';",
    'export async function GET() {',
    '  const rows = await db.invoice.findMany();',
    '  return Response.json(rows);',
    '}'
  ].join('\n'),
  'prisma/schema.prisma': 'model Invoice {\n  id    String @id\n  total Int\n}\n',
  'lib/weather.ts': [
    'export function forecastTemperature(city: string) {',
    '  return city.length * 3;',
    '}'
  ].join('\n')
};

test('feature slice follows a feature from page to data model', { skip }, async () => {
  await withFixture(invoiceApp, root => {
    const slice = FeatureSliceBuilder.build(root, 'invoices list');
    const files = slice.files.map(f => f.file);
    ['app/invoices/page.tsx', 'store/invoiceStore.ts', 'lib/api.ts', 'app/api/invoices/route.ts', 'prisma/schema.prisma']
      .forEach(file => assert.ok(files.includes(file), `${file} is in the slice: ${files.join(', ')}`));
    assert.ok(!files.includes('lib/weather.ts'), 'unrelated code stays out');

    assert.ok(slice.layers.data?.includes('prisma/schema.prisma'));
    assert.ok(slice.layers.server?.includes('app/api/invoices/route.ts'));
    assert.ok(slice.layers.ui?.includes('app/invoices/page.tsx'));
    slice.files.forEach(f => assert.ok(f.why.length > 0, `${f.file} says why it is included`));
    assert.ok(slice.edges.some(e => e.includes('schema.prisma')), `a data edge reaches the model: ${slice.edges.join('; ')}`);
    assert.ok(slice.tokens <= slice.budgetTokens);
  });
});

test('feature slice packs code to the token budget and reports what it left out', async () => {
  await withFixture(invoiceApp, root => {
    const roomy = FeatureSliceBuilder.build(root, 'invoices list');
    assert.ok(roomy.snippets.length > 0, 'a roomy budget includes code');

    const tight = FeatureSliceBuilder.build(root, 'invoices list', { budgetTokens: 120, maxFiles: 3 });
    assert.ok(tight.tokens <= 120 || tight.files.every(f => f.detail === 'ref'), `stays within budget: ${tight.tokens}`);
    assert.ok(tight.files.length <= 3);
    assert.ok(tight.snippets.length < roomy.snippets.length || roomy.snippets.length === 0);
    assert.ok(tight.omitted.length > 0, 'files cut by maxFiles are listed as omitted');
  });
});

test('feature slice says so when nothing matches', async () => {
  await withFixture({ 'lib/weather.ts': invoiceApp['lib/weather.ts'] }, root => {
    const slice = FeatureSliceBuilder.build(root, 'zzqx');
    assert.equal(slice.files.length, 0);
    assert.ok(slice.notes.length > 0);
  });
});
