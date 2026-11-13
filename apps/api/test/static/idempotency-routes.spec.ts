/**
 * Idempotency-Key coverage, static guard (CLAUDE.md «الترحيل», BUILD_PLAN
 * §10.3). The interceptor enforces the key only on handlers marked
 * @RequiresIdempotencyKey(), so a posting route that loses the marker would
 * post without a key. This reads the controllers and fails when:
 *  - a POST route whose path is a posting action (…/post, …/reverse,
 *    allocations and their cancel, vouchers and cash transfers that post on
 *    creation, the opening entry) has no marker;
 *  - the marker sits on a handler that is not a POST.
 */
import { read, sourceFiles } from './isolation-scan.js';

// Matched against `<controller path>/<route path>`, case-insensitively.
const POSTING_ROUTE =
  /\/(post|reverse|allocations|cancel|approve)$|(^|\/)(receipts|payments|cash-transfers)$|(^|\/)journal-entries\/opening$/i;
const HTTP_METHOD = /^@(Get|Post|Put|Patch|Delete|All)\(\s*(?:'([^']*)')?\s*\)/;
const METHOD_SIGNATURE = /^(async\s+)?[A-Za-z_]\w*\s*\(/;

interface Route {
  file: string;
  line: number;
  method: string;
  path: string;
  marked: boolean;
}

// Decorators this scan must understand; any other spelling of them (double
// quotes, template strings, constants, an options object) is reported as
// unparsed so a posting route cannot slip past the guard unread.
const ANY_ROUTE_DECORATOR = /^@(Controller|Get|Post|Put|Patch|Delete|All)\(/;
const CONTROLLER = /^@Controller\(\s*(?:'([^']*)')?\s*\)/;
const unparsed: string[] = [];

/** Every handler of a controller file with its HTTP method, full path and marker. */
function routes(file: string): Route[] {
  const lines = read(file).split(/\r?\n/);
  const found: Route[] = [];
  let base = '';
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!ANY_ROUTE_DECORATOR.test(text)) continue;
    const ctrl = CONTROLLER.exec(text);
    if (ctrl) {
      base = ctrl[1] ?? '';
      continue;
    }
    const http = HTTP_METHOD.exec(text);
    if (!http) {
      unparsed.push(`${file}:${i + 1} ${text}`);
      continue;
    }
    // The handler's decorator block: up to the previous member, down to the signature.
    let start = i;
    while (start > 0) {
      const prev = lines[start - 1].trim();
      if (prev === '' || prev === '}' || prev.endsWith('{') || prev.endsWith(';')) break;
      start--;
    }
    let end = i;
    while (end + 1 < lines.length && !METHOD_SIGNATURE.test(lines[end + 1].trim())) end++;
    const block = lines.slice(start, end + 1).join('\n');
    found.push({
      file,
      line: i + 1,
      method: http[1].toUpperCase(),
      path: [base, http[2] ?? ''].filter(Boolean).join('/'),
      marked: /@RequiresIdempotencyKey\(\)/.test(block),
    });
  }
  return found;
}

describe('Idempotency-Key — every posting route is marked (static)', () => {
  const all = sourceFiles()
    .filter((f) => f.endsWith('.controller.ts'))
    .flatMap(routes);

  it('reads the controllers', () => {
    expect(unparsed).toEqual([]);
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((r) => r.marked).length).toBeGreaterThanOrEqual(21);
  });

  it('marks every posting POST route', () => {
    const missing = all
      .filter((r) => r.method === 'POST' && POSTING_ROUTE.test(r.path) && !r.marked)
      .map((r) => `${r.file}:${r.line} POST ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('puts the marker only on POST handlers', () => {
    const misplaced = all
      .filter((r) => r.marked && r.method !== 'POST')
      .map((r) => `${r.file}:${r.line} ${r.method} ${r.path}`);
    expect(misplaced).toEqual([]);
  });
});
