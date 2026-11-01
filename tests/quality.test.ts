import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuplicationScanner } from '../src/quality/duplicationScanner.js';
import { ArchitectureDiagramBuilder } from '../src/graph/architectureDiagram.js';
import { withFixture } from './helpers.js';

const clone = [
  'const total = items.reduce((sum, item) => sum + item.price, 0);',
  'const tax = total * TAX_RATE;',
  'const shipping = total > FREE_SHIPPING ? 0 : SHIPPING_FEE;',
  'const discount = coupon ? coupon.apply(total) : 0;',
  'const grandTotal = total + tax + shipping - discount;',
  'logger.info(`order total ${grandTotal}`);',
  'return { total, tax, shipping, discount, grandTotal };'
];

const qualityFixture: Record<string, string> = {
  'src/checkout/cart.ts': ['export function cartTotals(items, coupon, logger) {', ...clone.map(l => '  ' + l), '}'].join('\n'),
  // Same block with different indentation and an interleaved comment is still a clone
  'src/orders/invoice.ts': ['import { x } from "../checkout/cart";', '', 'export function invoiceTotals(items, coupon, logger) {', '    // recompute', ...clone.map(l => '    ' + l), '}'].join('\n'),
  'src/orders/unique.ts': 'export const nothingShared = () => 1;\n',
  'tests/cart.test.ts': clone.join('\n')
};

test('DuplicationScanner finds a re-indented clone, skips tests unless asked and honours minLines', async () => {
  await withFixture(qualityFixture, root => {
    const dup = DuplicationScanner.scan(root);
    assert.strictEqual(dup.blocks.length, 1, `Expected one clone, got ${JSON.stringify(dup.blocks)}`);
    assert.deepStrictEqual(dup.blocks[0].occurrences.map(o => `${o.filePath}:${o.startLine}-${o.endLine}`), ['src/checkout/cart.ts:2-8', 'src/orders/invoice.ts:5-11']);
    assert.strictEqual(dup.blocks[0].lines, 7);
    assert.strictEqual(DuplicationScanner.scan(root, { includeTests: true }).blocks[0].occurrences.length, 3, 'Tests are scanned only when asked');
    assert.strictEqual(DuplicationScanner.scan(root, { minLines: 8 }).blocks.length, 0, 'Blocks shorter than minLines are not reported');
  }, 'cb-trainer-quality-');
});

test('architecture diagram is built from resolved imports, with module cycles', async () => {
  await withFixture({
    ...qualityFixture,
    'src/orders/service.ts': "import { cartTotals } from '../checkout/cart';\nimport { audit } from '../audit/log';\nexport const run = () => audit(cartTotals);\n",
    'src/audit/log.ts': "import { run } from '../orders/service';\nexport const audit = (x: unknown) => run;\n"
  }, root => {
    const arch = ArchitectureDiagramBuilder.build(root);
    const deps = arch.dependencies.map(d => `${d.from}->${d.to}:${d.imports}`).sort();
    assert.deepStrictEqual(deps, ['src/audit->src/orders:1', 'src/orders->src/audit:1', 'src/orders->src/checkout:2'], `Unexpected dependencies ${deps.join(', ')}`);
    assert.deepStrictEqual(arch.moduleCycles, [['src/audit', 'src/orders']]);
    assert.ok(arch.mermaidDiagram.split('\n').length > 3 && !arch.mermaidDiagram.includes('\\n'), 'Mermaid must use real newlines');
    assert.ok(arch.mermaidDiagram.includes('m_src_orders -->|2| m_src_checkout'));
    assert.ok(!arch.modules.some(m => m.id === 'tests'), 'Test files are not architecture modules');
  }, 'cb-trainer-quality-');
});
