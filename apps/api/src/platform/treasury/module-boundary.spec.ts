import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Module boundary (CLAUDE.md, ADR-004): treasury reads and settles invoices
 * only through SalesInvoicesService / PurchaseInvoicesService. A model call
 * (`tx.salesInvoice…`) or a table name in raw SQL here would bypass them.
 */
const FORBIDDEN = [
  /\.(salesInvoice|purchaseInvoice|salesReturn|purchaseReturn)(Line)?\b/,
  /\b(sales_invoices|purchase_invoices|sales_returns|purchase_returns)\b/,
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('treasury module boundary', () => {
  it('never touches the sales or purchase invoice tables directly', () => {
    const offenders: string[] = [];
    for (const file of sources(import.meta.dirname)) {
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (FORBIDDEN.some((re) => re.test(line))) {
            offenders.push(`${path.basename(file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
