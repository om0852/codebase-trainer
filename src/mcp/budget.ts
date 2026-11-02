/**
 * Token discipline for tool output: if a result is larger than its budget, the longest lists are cut from the end
 * (results are ranked, so the tail matters least) and long strings are shortened, and the result says what was
 * dropped. ~4 characters per token, the same estimate the rest of the tool uses.
 */

export const DEFAULT_TOOL_BUDGET = 8000;

export interface BudgetReport {
  tokens: number;
  budgetTokens: number;
  // `path: kept N of M` for every list that was cut
  omitted?: string[];
}

const tokensOf = (value: unknown) => Math.ceil(JSON.stringify(value ?? null).length / 4);

interface ListRef { path: string; list: unknown[]; original: number }

export function fitToBudget<T>(value: T, budgetTokens: number = DEFAULT_TOOL_BUDGET): { value: T; budget: BudgetReport } {
  const original = tokensOf(value);
  if (original <= budgetTokens) return { value, budget: { tokens: original, budgetTokens } };

  const copy = JSON.parse(JSON.stringify(value)) as T;
  const lists: ListRef[] = [];
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) {
      lists.push({ path: at || '(root)', list: node, original: node.length });
      node.forEach((item, i) => walk(item, `${at}[${i}]`));
    } else if (node && typeof node === 'object') {
      Object.entries(node as Record<string, unknown>).forEach(([key, child]) => walk(child, at ? `${at}.${key}` : key));
    }
  };
  walk(copy, '');

  // Halve the list that costs the most until the result fits; nested lists of dropped items go with them
  for (let guard = 0; guard < 200 && tokensOf(copy) > budgetTokens; guard++) {
    const candidates = lists.filter(l => l.list.length > 1).map(l => ({ l, cost: tokensOf(l.list) })).sort((a, b) => b.cost - a.cost);
    if (candidates.length === 0) break;
    const { l } = candidates[0];
    l.list.splice(Math.max(1, Math.floor(l.list.length / 2)));
  }

  // Still over (one huge item): shorten the longest strings
  for (let guard = 0; guard < 50 && tokensOf(copy) > budgetTokens; guard++) {
    let longest: { holder: Record<string, unknown> | unknown[]; key: string | number; length: number } | null = null;
    const find = (node: unknown) => {
      if (Array.isArray(node)) node.forEach((item, i) => {
        if (typeof item === 'string' && (!longest || item.length > longest.length)) longest = { holder: node, key: i, length: item.length };
        else find(item);
      });
      else if (node && typeof node === 'object') Object.entries(node as Record<string, unknown>).forEach(([key, child]) => {
        if (typeof child === 'string' && (!longest || child.length > longest.length)) longest = { holder: node as Record<string, unknown>, key, length: child.length };
        else find(child);
      });
    };
    find(copy);
    const target = longest as { holder: Record<string, unknown> | unknown[]; key: string | number; length: number } | null;
    if (!target || target.length < 200) break;
    const text = (target.holder as Record<string | number, string>)[target.key];
    (target.holder as Record<string | number, string>)[target.key] = `${text.slice(0, Math.floor(text.length / 2))}… [truncated]`;
  }

  const omitted = lists
    .filter(l => l.list.length < l.original)
    // Report only lists that survived (not ones inside dropped items)
    .filter(l => !lists.some(other => other !== l && l.path.startsWith(other.path + '[') && Number(l.path.slice(other.path.length + 1).split(']')[0]) >= other.list.length))
    .map(l => `${l.path}: kept ${l.list.length} of ${l.original}`);
  return { value: copy, budget: { tokens: tokensOf(copy), budgetTokens, ...(omitted.length > 0 && { omitted }) } };
}
