/**
 * Source scanning for interactive `$transaction` calls: each call's argument
 * text, found by matching parentheses (string and template contents are
 * skipped, so SQL or messages holding parentheses do not confuse it).
 */

export interface TransactionCall {
  line: number;
  /** Text between the call's parentheses. */
  args: string;
  /** Index of the call's closing parenthesis in the source. */
  end: number;
  /** false for the batch form `$transaction([...])`. */
  interactive: boolean;
}

/** Index just past a string or template literal that starts at `from`. */
function skipLiteral(source: string, from: number): number {
  const quote = source[from];
  for (let i = from + 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') i += 1;
    else if (c === quote) return i + 1;
    else if (quote === '`' && c === '$' && source[i + 1] === '{') i = skipBalanced(source, i + 1) - 1;
  }
  return source.length;
}

/** Index just past the bracket that closes the one opened at `from`. */
function skipBalanced(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipLiteral(source, i) - 1;
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return source.length;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
      if (i <= 0) return source.length;
    } else if (c === '(' || c === '{' || c === '[') {
      depth += 1;
    } else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

export function transactionCalls(source: string): TransactionCall[] {
  const out: TransactionCall[] = [];
  for (const m of source.matchAll(/\$transaction\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const end = skipBalanced(source, open) - 1;
    const args = source.slice(open + 1, end);
    out.push({
      line: source.slice(0, m.index).split('\n').length,
      args,
      end,
      interactive: !args.trimStart().startsWith('['),
    });
  }
  return out;
}
