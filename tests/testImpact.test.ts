import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestImpactAnalyzer } from '../src/graph/testImpact.js';
import { DiffChecker } from '../src/review/diffChecker.js';
import { DiffParser } from '../src/review/diffParser.js';
import { withFixture } from './helpers.js';

const widgetApp: Record<string, string> = {
  'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
  'src/widget.ts': 'export function parseWidget(raw: string) {\n  return raw.trim();\n}\n',
  'src/store.ts': "import { parseWidget } from './widget';\nexport const load = (raw: string) => parseWidget(raw);\n",
  'src/unrelated.ts': 'export const answer = 42;\n',
  'tests/store.test.ts': "import { load } from '../src/store';\nimport { test } from 'vitest';\ntest('loads', () => load(' x '));\n",
  // A helper is not a test: tests that use it are reached through it
  'tests/fixtures.ts': "import { parseWidget } from '../src/widget';\nexport const sample = parseWidget(' y ');\n",
  'tests/sample.test.ts': "import { sample } from './fixtures';\nimport { test } from 'vitest';\ntest('sample', () => sample);\n",
  // Reaches the code only at runtime, but names it
  'tests/e2e.test.ts': "import { test } from 'vitest';\ntest('parseWidget over HTTP', async () => fetch('/api/widgets'));\n",
  'tests/unrelated.test.ts': "import { answer } from '../src/unrelated';\nimport { test } from 'vitest';\ntest('answer', () => answer);\n"
};

test('test impact: tests importing the change directly, through modules and through helpers', async () => {
  await withFixture(widgetApp, root => {
    const impact = TestImpactAnalyzer.forTargets(root, ['src/widget.ts']);
    const byFile = new Map(impact.tests.map(t => [t.file, t]));
    assert.equal(impact.totalTests, 4, 'helpers are not counted as tests');
    assert.equal(byFile.get('tests/store.test.ts')?.via, 'import');
    assert.equal(byFile.get('tests/store.test.ts')?.distance, 2);
    assert.match(byFile.get('tests/store.test.ts')!.reason, /via src\/store\.ts/);
    assert.match(byFile.get('tests/sample.test.ts')!.reason, /via tests\/fixtures\.ts/);
    assert.equal(byFile.get('tests/e2e.test.ts')?.via, 'name', 'named after the changed file');
    assert.ok(!byFile.has('tests/unrelated.test.ts'));

    assert.equal(impact.commands.length, 1);
    assert.equal(impact.commands[0].runner, 'vitest');
    assert.equal(impact.commands[0].command, 'npx vitest run tests/sample.test.ts tests/store.test.ts tests/e2e.test.ts');
  });
});

test('test impact: a symbol target and a changed test', async () => {
  await withFixture(widgetApp, root => {
    const bySymbol = TestImpactAnalyzer.forTargets(root, ['parseWidget']);
    assert.deepEqual(bySymbol.targets, ['src/widget.ts']);
    assert.ok(bySymbol.tests.some(t => t.file === 'tests/store.test.ts'));

    const changedTest = TestImpactAnalyzer.forTargets(root, ['tests/unrelated.test.ts']);
    assert.deepEqual(changedTest.tests.map(t => `${t.via} ${t.file}`), ['changed tests/unrelated.test.ts']);
  });
});

test('test impact: runners per package, node:test, and pytest', async () => {
  await withFixture({
    'package.json': JSON.stringify({ scripts: { test: 'tsx --test "tests/**/*.test.ts"' } }),
    'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
    'tests/math.test.ts': "import { test } from 'node:test';\nimport { add } from '../src/math';\ntest('add', () => add(1, 2));\n",
    'packages/api/package.json': JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    'packages/api/src/math-client.ts': "import { add } from '../../../src/math';\nexport const total = add(1, 1);\n",
    'packages/api/src/math-client.spec.ts': "import { total } from './math-client';\nit('totals', () => expect(total).toBe(2));\n",
    'service/app/calc.py': 'def add(a, b):\n    return a + b\n',
    'service/pyproject.toml': '[tool.pytest.ini_options]\n',
    'service/tests/test_calc.py': 'from app.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n'
  }, root => {
    const ts = TestImpactAnalyzer.forTargets(root, ['src/math.ts']);
    assert.deepEqual(ts.commands.map(c => c.command).sort(), [
      'cd packages/api && npx jest src/math-client.spec.ts',
      'npx tsx --test tests/math.test.ts'
    ]);

    const py = TestImpactAnalyzer.forTargets(root, ['service/app/calc.py']);
    assert.deepEqual(py.commands.map(c => c.command), ['cd service && pytest tests/test_calc.py']);
  });
});

test('diff checker lists the tests to run for a diff', async () => {
  await withFixture(widgetApp, root => {
    const report = DiffChecker.checkFiles(root, [DiffParser.asAddedFile('src/store.ts', widgetApp['src/store.ts'])], 'test');
    assert.deepEqual(report.testsToRun?.tests.map(t => t.file), ['tests/store.test.ts']);
    assert.equal(report.testsToRun?.commands[0].command, 'npx vitest run tests/store.test.ts');
  });
});
