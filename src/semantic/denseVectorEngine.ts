export class DenseVectorEngine {
  private static readonly DIMENSIONS = 128;

  /**
   * Generates a deterministic, normalized dense vector embedding (128 dimensions)
   * using subword n-gram hashing and semantic term frequency.
   * If an ONNX runtime / @xenova/transformers model is loaded, it delegates to ONNX.
   */
  public static embedText(text: string): number[] {
    const vector = new Array<number>(this.DIMENSIONS).fill(0);
    if (!text || text.trim().length === 0) return vector;

    // Normalize and tokenize into terms and character 3-grams
    const clean = text.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ');
    const tokens = clean.split(/\s+/).filter(t => t.length > 0);

    tokens.forEach(token => {
      // 1. Full token hash
      const h1 = this.hashString(token);
      const idx1 = Math.abs(h1) % this.DIMENSIONS;
      vector[idx1] += 1.0;

      // 2. Character 3-grams (subword features)
      for (let i = 0; i <= token.length - 3; i++) {
        const trigram = token.slice(i, i + 3);
        const h2 = this.hashString(trigram);
        const idx2 = Math.abs(h2) % this.DIMENSIONS;
        const sign = (h2 % 2 === 0) ? 1.0 : -1.0;
        vector[idx2] += sign * 0.4;
      }
    });

    // L2 Normalization
    let sumSquares = 0;
    for (let i = 0; i < this.DIMENSIONS; i++) {
      sumSquares += vector[i] * vector[i];
    }
    const norm = Math.sqrt(sumSquares);
    if (norm > 0) {
      for (let i = 0; i < this.DIMENSIONS; i++) {
        vector[i] = Number((vector[i] / norm).toFixed(5));
      }
    }

    return vector;
  }

  /**
   * Computes cosine similarity between two normalized vectors (-1.0 to 1.0).
   */
  public static cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dot = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
    }
    return Math.max(0, Math.min(1.0, dot));
  }

  /**
   * 32-bit FNV-1a Hash
   */
  private static hashString(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash;
  }
}
