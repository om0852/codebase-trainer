import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CodeChunk } from './searchEngine.js';
import { ProjectConfigLoader } from '../config/projectConfig.js';

/**
 * Optional neural embeddings. Off by default: nothing is downloaded or loaded until a repo opts in with
 * `cb-trainer embeddings enable` (or `init --embeddings`), which writes `.codebase/neural/config.json`.
 * Needs the optional peer dependency `@huggingface/transformers` (`npm install @huggingface/transformers`); the model (a small quantized ONNX file) is downloaded
 * once into ~/.cache/codebase-trainer/models and runs locally on the CPU.
 */

export interface NeuralModel {
  id: string;
  // Prefixes some models were trained with, for queries and for the passages they are matched against
  queryPrefix?: string;
  passagePrefix?: string;
}

export const NEURAL_MODELS: Record<string, NeuralModel> = {
  'Xenova/all-MiniLM-L6-v2': { id: 'Xenova/all-MiniLM-L6-v2' },
  'Xenova/bge-small-en-v1.5': { id: 'Xenova/bge-small-en-v1.5', queryPrefix: 'Represent this sentence for searching relevant passages: ' },
  'Snowflake/snowflake-arctic-embed-xs': { id: 'Snowflake/snowflake-arctic-embed-xs', queryPrefix: 'Represent this sentence for searching relevant passages: ' },
  'Xenova/jina-embeddings-v2-small-en': { id: 'Xenova/jina-embeddings-v2-small-en' }
};

export const DEFAULT_NEURAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

export interface NeuralConfig {
  model: string;
  enabledAt: string;
}

interface VectorStoreMeta {
  model: string;
  dims: number;
  // Content hash per stored vector, in the order of vectors.bin
  hashes: string[];
}

type Extractor = (texts: string[], options: { pooling: 'mean' | 'cls'; normalize: boolean }) => Promise<{ dims: number[]; data: Float32Array }>;

// Characters of a chunk passed to the model; small models read at most 256-512 word pieces anyway
const MAX_CHARS = 1500;
const BATCH = 32;
// Not a regular dependency (an optional peer, so installs stay small): loaded by name so builds do not need it
const TRANSFORMERS = '@huggingface/transformers';

export class NeuralEmbeddings {
  private static extractors = new Map<string, Promise<Extractor>>();

  public static configPath(repoPath: string): string {
    return path.join(repoPath, '.codebase', 'neural', 'config.json');
  }

  /**
   * The repo's opt-in: `embeddings` in codebase-trainer.yaml (shared by the team) wins, then the local opt-in from
   * `cb-trainer embeddings enable`. CODEBASE_TRAINER_EMBEDDINGS=0 turns it off.
   */
  public static config(repoPath: string): NeuralConfig | null {
    if (process.env.CODEBASE_TRAINER_EMBEDDINGS === '0') return null;
    const shared = ProjectConfigLoader.load(repoPath).embeddings;
    if (shared) return shared.enabled ? { model: shared.model ?? DEFAULT_NEURAL_MODEL, enabledAt: 'codebase-trainer.yaml' } : null;
    try {
      return JSON.parse(fs.readFileSync(this.configPath(repoPath), 'utf8'));
    } catch {
      return null;
    }
  }

  public static enable(repoPath: string, model: string = DEFAULT_NEURAL_MODEL): NeuralConfig {
    const config = { model, enabledAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.configPath(repoPath)), { recursive: true });
    fs.writeFileSync(this.configPath(repoPath), JSON.stringify(config, null, 2), 'utf8');
    return config;
  }

  public static disable(repoPath: string): void {
    fs.rmSync(path.join(repoPath, '.codebase', 'neural'), { recursive: true, force: true });
  }

  /** Whether the optional dependency is installed. */
  public static async isInstalled(): Promise<boolean> {
    try {
      await import(TRANSFORMERS);
      return true;
    } catch {
      return false;
    }
  }

  public static modelCacheDir(): string {
    return process.env.CODEBASE_TRAINER_MODEL_CACHE || path.join(os.homedir(), '.cache', 'codebase-trainer', 'models');
  }

  /**
   * Unit-length vectors, one per text. Loads (and on first use downloads) the model.
   */
  public static async embed(model: string, texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const spec = NEURAL_MODELS[model] ?? { id: model };
    const prefix = (kind === 'query' ? spec.queryPrefix : spec.passagePrefix) ?? '';
    const extract = await this.extractor(spec.id);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map(t => prefix + t.slice(0, MAX_CHARS));
      const output = await extract(batch, { pooling: 'mean', normalize: true });
      const dims = output.dims[output.dims.length - 1];
      for (let row = 0; row < batch.length; row++) vectors.push(output.data.slice(row * dims, (row + 1) * dims));
    }
    return vectors;
  }

  /**
   * Vectors for `chunks`, keyed by chunk id. Vectors are stored by content hash in `.codebase/neural/`, so only new
   * or edited chunks are embedded; vectors for chunks that no longer exist are dropped.
   */
  public static async chunkVectors(repoPath: string, model: string, chunks: CodeChunk[]): Promise<{ vectors: Map<string, Float32Array>; embedded: number }> {
    const dir = path.join(repoPath, '.codebase', 'neural');
    const metaPath = path.join(dir, 'vectors.json');
    const binPath = path.join(dir, 'vectors.bin');
    const textOf = (c: CodeChunk) => `${path.relative(repoPath, c.filePath).replace(/\\/g, '/')}\n${c.content}`;
    const hashOf = (text: string) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

    const byHash = new Map<string, Float32Array>();
    try {
      const meta: VectorStoreMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.model === model) {
        const raw = fs.readFileSync(binPath);
        const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
        meta.hashes.forEach((hash, i) => byHash.set(hash, all.slice(i * meta.dims, (i + 1) * meta.dims)));
      }
    } catch {
      // No store yet, or one for another model: embed everything
    }

    const texts = chunks.map(textOf);
    const hashes = texts.map(hashOf);
    const missing = [...new Set(hashes.filter(h => !byHash.has(h)))];
    if (missing.length > 0) {
      const textByHash = new Map(hashes.map((h, i) => [h, texts[i]]));
      const fresh = await this.embed(model, missing.map(h => textByHash.get(h)!), 'passage');
      missing.forEach((h, i) => byHash.set(h, fresh[i]));
    }

    const vectors = new Map(chunks.map((c, i) => [c.id, byHash.get(hashes[i])!]));
    if (missing.length > 0 || byHash.size !== new Set(hashes).size) {
      const kept = [...new Set(hashes)];
      const dims = byHash.get(kept[0])?.length ?? 0;
      const packed = new Float32Array(kept.length * dims);
      kept.forEach((h, i) => packed.set(byHash.get(h)!, i * dims));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(binPath, Buffer.from(packed.buffer));
      fs.writeFileSync(metaPath, JSON.stringify({ model, dims, hashes: kept } satisfies VectorStoreMeta), 'utf8');
    }
    return { vectors, embedded: missing.length };
  }

  public static dot(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
  }

  private static extractor(modelId: string): Promise<Extractor> {
    let pending = this.extractors.get(modelId);
    if (!pending) {
      pending = (async () => {
        const transformers = await import(TRANSFORMERS);
        transformers.env.cacheDir = this.modelCacheDir();
        return await transformers.pipeline('feature-extraction', modelId, { dtype: 'q8' }) as unknown as Extractor;
      })();
      this.extractors.set(modelId, pending);
    }
    return pending;
  }
}
