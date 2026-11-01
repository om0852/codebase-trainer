/**
 * Bump when tokenize() output changes: indexes store pre-computed tokens and are rebuilt on mismatch.
 */
export const TOKENIZER_VERSION = 2;

// Question scaffolding and function words. Removed from queries only (never from indexed code), and only
// when the query keeps at least one other word, so "how does import resolution work" searches
// for "import resolution".
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'into', 'about', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done', 'doing',
  'how', 'what', 'where', 'when', 'why', 'which', 'who', 'whom', 'whose',
  'this', 'that', 'these', 'those', 'it', 'its', 'there', 'here',
  'i', 'me', 'my', 'we', 'our', 'us', 'you', 'your', 'they', 'their', 'them',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'has', 'have', 'had',
  'please', 'work', 'works', 'happen', 'happens', 'handled', 'implemented', 'located', 'code'
]);

// [suffix, replacement, minimum stem length left after removing the suffix]
// Longest suffix first; e.g. "-ification" -> "ify" so classification/classifier/classify share "classify".
const SUFFIX_RULES: Array<[string, string, number]> = [
  ['ification', 'ify', 3],
  ['ization', '', 3], ['isation', '', 3],
  ['izing', '', 3], ['izer', '', 3], ['ized', '', 3], ['ize', '', 3],
  ['ments', '', 3], ['ment', '', 3],
  ['ness', '', 3],
  ['able', '', 3], ['ible', '', 3],
  ['sses', 'ss', 2],
  ['ies', 'y', 2], ['ied', 'y', 2], ['ier', 'y', 2],
  ['ing', '', 3],
  ['ion', '', 4],
  ['ity', '', 3],
  ['ive', '', 3],
  ['ers', '', 3], ['ors', '', 3],
  ['er', '', 3], ['or', '', 3],
  ['ed', '', 3],
  ['ly', '', 3]
];

// Latin roots whose noun and verb forms differ after suffix removal: resolution/resolve, description/describe
const ROOT_FIXES: Array<[RegExp, string]> = [
  [/olut$/, 'olv'],
  [/ript$/, 'rib'],
  [/uct$/, 'uc']
];

const stemCache = new Map<string, string>();

export class TextNormalizer {
  /**
   * Lowercased words: camelCase, PascalCase, acronyms (`parseHTTPRequest`), snake_case and kebab-case
   * are split; single characters are dropped.
   */
  public static words(text: string): string[] {
    return text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(w => w.length > 1);
  }

  /**
   * Light stemmer for code vocabulary: maps word families to one stem
   * (resolve/resolver/resolution -> resolv, duplicate/duplicated/duplication -> duplicat).
   */
  public static stem(word: string): string {
    const cached = stemCache.get(word);
    if (cached !== undefined) return cached;

    let stem = word;
    if (/^[a-z]+$/.test(word) && word.length > 3) {
      for (let pass = 0; pass < 3; pass++) {
        const next = this.stemOnce(stem);
        if (next === stem) break;
        stem = next;
      }
      ROOT_FIXES.forEach(([pattern, replacement]) => { stem = stem.replace(pattern, replacement); });
    }
    stemCache.set(word, stem);
    return stem;
  }

  public static tokenize(text: string): string[] {
    return this.words(text).map(w => this.stem(w));
  }

  /**
   * Query tokens with question scaffolding removed (unless nothing else is left).
   */
  public static tokenizeQuery(query: string): string[] {
    return this.queryContentWords(query).map(w => this.stem(w));
  }

  public static isQueryStopword(word: string): boolean {
    return QUERY_STOPWORDS.has(word.toLowerCase());
  }

  /**
   * Unstemmed query words without question scaffolding, for similarity measures that work on raw text.
   */
  public static queryContentWords(query: string): string[] {
    const words = this.words(query);
    const content = words.filter(w => !QUERY_STOPWORDS.has(w));
    return content.length > 0 ? content : words;
  }

  private static stemOnce(word: string): string {
    // Plurals first: classes -> class, indexes -> index, files -> file; keep class, status, analysis
    if (/(ss|x|z|ch|sh)es$/.test(word) && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('s') && !/(ss|us|is)$/.test(word) && word.length > 3 && !word.endsWith('ies')) return word.slice(0, -1);

    for (const [suffix, replacement, minStem] of SUFFIX_RULES) {
      if (!word.endsWith(suffix)) continue;
      const base = word.slice(0, word.length - suffix.length);
      if (base.length < minStem) continue;
      let result = base + replacement;
      // mapped -> mapp -> map, running -> runn -> run (but call, pass, buzz keep their double letter)
      if (['ing', 'ed', 'er', 'ers'].includes(suffix) && /([b-df-hj-kmnp-rtv-y])\1$/.test(result)) result = result.slice(0, -1);
      return result;
    }

    // Trailing silent e: create -> creat, resolve -> resolv, name -> nam (matching naming -> nam)
    if (word.endsWith('e') && word.length > 3) return word.slice(0, -1);
    return word;
  }
}
