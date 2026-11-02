import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NeuralEmbeddings } from '../src/semantic/neuralEmbeddings.js';
import { SemanticSearchEngine } from '../src/semantic/searchEngine.js';
import { withFixture } from './helpers.js';

// Stand-in for the model: a "concept" vector, so text about payments is close to "billing" without sharing a word
const CONCEPTS: Array<[RegExp, number]> = [[/billing|invoice|payment|charge/i, 0], [/weather|forecast|temperature/i, 1], [/./, 2]];
const fakeEmbed = async (_model: string, texts: string[]) => texts.map(text => {
  const v = new Float32Array(3);
  v[CONCEPTS.find(([pattern]) => pattern.test(text))![1]] = 1;
  return v;
});

const files = {
  'src/charges.ts': 'export function createCharge(amountCents: number) {\n  return stripe.charges.create({ amount: amountCents });\n}\n',
  'src/forecast.ts': 'export function forecastTemperature(city: string) {\n  return city.length;\n}\n',
  'src/billing-notes.ts': 'export const billingNotes = "billing";\n'
};

test('neural search is off unless the repo opts in, and loads nothing then', async () => {
  await withFixture(files, async root => {
    assert.equal(NeuralEmbeddings.config(root), null);
    const result = await SemanticSearchEngine.searchWithStatusAsync(root, 'forecast temperature', 3);
    assert.equal(result.neural, undefined);
    assert.deepEqual(result.results.map(r => r.filePath), SemanticSearchEngine.search(root, 'forecast temperature', 3).map(r => r.filePath));
    assert.ok(!fs.existsSync(path.join(root, '.codebase', 'neural')));
  });
});

test('neural search: opt-in, vectors cached by content, and rank fusion', async () => {
  const realEmbed = NeuralEmbeddings.embed;
  NeuralEmbeddings.embed = fakeEmbed;
  try {
    await withFixture(files, async root => {
      NeuralEmbeddings.enable(root, 'fake-model');
      const first = await SemanticSearchEngine.searchWithStatusAsync(root, 'how are payments handled', 3);
      assert.equal(first.neural?.model, 'fake-model');
      assert.ok(first.neural!.embedded > 0);
      // Nothing lexical matches src/billing-notes.ts; the neural ranking brings it in
      assert.ok(first.results.some(r => r.filePath.endsWith('billing-notes.ts') && r.matchType === 'neural'), JSON.stringify(first.results));
      assert.ok(first.results.some(r => r.filePath.endsWith('charges.ts') && r.neuralSimilarity === 1));

      const again = await SemanticSearchEngine.searchWithStatusAsync(root, 'forecast', 3);
      assert.equal(again.neural?.embedded, 0, 'unchanged chunks are not embedded again');

      fs.appendFileSync(path.join(root, 'src/forecast.ts'), 'export const unit = "celsius";\n');
      const edited = await SemanticSearchEngine.searchWithStatusAsync(root, 'forecast', 3);
      assert.ok(edited.neural!.embedded >= 1 && edited.neural!.embedded < first.neural!.embedded, 'only edited chunks are embedded');

      process.env.CODEBASE_TRAINER_EMBEDDINGS = '0';
      try {
        assert.equal((await SemanticSearchEngine.searchWithStatusAsync(root, 'forecast', 3)).neural, undefined);
      } finally {
        delete process.env.CODEBASE_TRAINER_EMBEDDINGS;
      }

      NeuralEmbeddings.disable(root);
      assert.equal(NeuralEmbeddings.config(root), null);
    });
  } finally {
    NeuralEmbeddings.embed = realEmbed;
  }
});

test('neural search falls back to lexical results when the model cannot load', async () => {
  const realEmbed = NeuralEmbeddings.embed;
  NeuralEmbeddings.embed = async () => { throw new Error('model download blocked'); };
  try {
    await withFixture(files, async root => {
      NeuralEmbeddings.enable(root, 'fake-model');
      const result = await SemanticSearchEngine.searchWithStatusAsync(root, 'forecast temperature', 3);
      assert.equal(result.neural, undefined);
      assert.match(result.neuralSkipped ?? '', /model download blocked/);
      assert.ok(result.results.some(r => r.filePath.endsWith('forecast.ts')));
    });
  } finally {
    NeuralEmbeddings.embed = realEmbed;
  }
});
