/**
 * Permission coverage, static guard (review PLAT-28). Every tenant route must
 * name the permission it needs, so a new route cannot ship open to every member
 * by omission. This reads the controllers and fails when:
 *  - a handler is neither exempt (@Public, @TenantOptional, @PlatformAdmin) nor
 *    guarded by @RequirePermission on the handler or its class, and is not
 *    listed in ALLOWED_WITHOUT_PERMISSION;
 *  - a listed handler now has a permission, or no longer exists (stale entry).
 */
import { read, sourceFiles } from './isolation-scan.js';

const HTTP_METHOD = /^@(Get|Post|Put|Patch|Delete|All)\(/;
const CLASS_DECLARATION = /^export class (\w+)\b/;
const METHOD_SIGNATURE = /^(async\s+)?([A-Za-z_]\w*)\s*\(/;
const EXEMPT = /@(Public|TenantOptional|PlatformAdmin)\(\)/;
const GUARDED = /@RequirePermission\(/;

// Reads any member may make. Wave 3 gives each an explicit @RequirePermission; never add to this list.
const ALLOWED_WITHOUT_PERMISSION: string[] = [];

interface Handler {
  file: string;
  line: number;
  controller: string;
  method: string;
  exempt: boolean;
  guarded: boolean;
}

/**
 * The decorator block that sits directly above line `index`: up to the previous
 * member (a line ending a body, or a blank line) and down to the given line.
 */
function decoratorBlock(lines: string[], index: number): string {
  let start = index;
  while (start > 0) {
    const prev = lines[start - 1].trim();
    // A member ends with a brace or a semicolon; a decorator's argument list ends with `)` or `,`.
    if (prev === '' || prev.endsWith('}') || prev.endsWith('{') || prev.endsWith(';')) break;
    start--;
  }
  return lines.slice(start, index + 1).join('\n');
}

/** Every HTTP handler of a controller file, with its class and its guards. */
function handlers(file: string): Handler[] {
  const lines = read(file).split(/\r?\n/);
  const found: Handler[] = [];
  let controller = '';
  let classBlock = '';
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    const declared = CLASS_DECLARATION.exec(text);
    if (declared) {
      controller = declared[1];
      classBlock = decoratorBlock(lines, i);
      continue;
    }
    if (!HTTP_METHOD.test(text)) continue;

    // The handler's decorators run down to its signature (parameters may span lines).
    let end = i;
    while (end + 1 < lines.length && !METHOD_SIGNATURE.test(lines[end + 1].trim())) end++;
    const signature = METHOD_SIGNATURE.exec(lines[end + 1].trim());
    const block = decoratorBlock(lines, end);
    const guards = `${classBlock}\n${block}`;
    found.push({
      file,
      line: i + 1,
      controller,
      method: signature?.[2] ?? '?',
      exempt: EXEMPT.test(guards),
      guarded: GUARDED.test(guards),
    });
  }
  return found;
}

const all = sourceFiles()
  .filter((f) => f.endsWith('.controller.ts'))
  .flatMap(handlers);
const key = (h: Handler) => `${h.controller}.${h.method}`;
const unguarded = all.filter((h) => !h.exempt && !h.guarded);

describe('Permissions — every tenant route names its permission (static)', () => {
  it('reads the controllers', () => {
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((h) => h.guarded).length).toBeGreaterThan(100);
  });

  it('gives every route not in the list a permission', () => {
    const missing = unguarded
      .filter((h) => !ALLOWED_WITHOUT_PERMISSION.includes(key(h)))
      .map((h) => `${h.file}:${h.line} ${key(h)}`);
    expect(missing).toEqual([]);
  });

  it('keeps the list free of routes that now have a permission (no stale entries)', () => {
    const stale = ALLOWED_WITHOUT_PERMISSION.filter(
      (k) => !unguarded.some((h) => key(h) === k),
    );
    expect(stale).toEqual([]);
  });

  it('never lists the user management routes (PLAT-28)', () => {
    expect(ALLOWED_WITHOUT_PERMISSION.filter((k) => k.startsWith('UsersController.'))).toEqual([]);
  });

  it('names each handler once', () => {
    const keys = all.map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
