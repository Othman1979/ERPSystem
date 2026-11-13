/**
 * Posting transaction options, static guard (CLAUDE.md «الترحيل»: one
 * interactive transaction with `timeout: 30000`; BUILD_PLAN §10.1/§10.2).
 *
 * Every interactive `$transaction` in a file that posts journal entries or
 * stock movements (it uses PostingService or StockLedgerService), and in the
 * fiscal-year service (create, close and reopen a year), must pass
 * POSTING_TX_OPTIONS. Without it Prisma's 5 s default applies and a large
 * document fails with P2028 halfway.
 */
import { POSTING_TX_OPTIONS } from '../../src/prisma/transaction-options.js';
import { read, sourceFiles } from './isolation-scan.js';
import { transactionCalls, txMethodBodies } from './transaction-scan.js';

/** Posting services that do not import PostingService / StockLedgerService themselves. */
const ALSO_POSTING = ['src/platform/accounting/fiscal.service.ts'];

const USES_POSTING = /from '[./]*(?:journal\/)?posting\.service\.js'|from '[./]*(?:inventory\/)?stock-ledger\.service\.js'/;

function postingFiles(): string[] {
  return sourceFiles().filter(
    (f) =>
      ALSO_POSTING.includes(f) ||
      (!/\.(module|controller)\.ts$/.test(f) &&
        !/\/(posting|stock-ledger)\.service\.ts$/.test(f) &&
        USES_POSTING.test(read(f))),
  );
}

describe('Posting transactions — static guard (CLAUDE.md «الترحيل»)', () => {
  it('uses a 30 s timeout', () => {
    expect(POSTING_TX_OPTIONS.timeout).toBe(30_000);
    expect(POSTING_TX_OPTIONS.maxWait).toBeGreaterThanOrEqual(5_000);
  });

  it('finds the posting services', () => {
    const files = postingFiles();
    for (const f of [
      'src/platform/journal/journal.service.ts',
      'src/platform/sales/sales-invoices.service.ts',
      'src/platform/sales/sales-returns.service.ts',
      'src/platform/purchases/purchase-invoices.service.ts',
      'src/platform/purchases/purchase-returns.service.ts',
      'src/platform/goods-notes/goods-notes.service.ts',
      'src/platform/inventory/adjustments.service.ts',
      'src/platform/inventory/transfers.service.ts',
      'src/platform/inventory/counts.service.ts',
      'src/platform/treasury/vouchers.service.ts',
      'src/platform/treasury/cash-transfers.service.ts',
      'src/platform/accounting/fiscal.service.ts',
    ]) {
      expect(files).toContain(f);
    }
  });

  it('parses nested calls, strings and SQL with parentheses', () => {
    const src = [
      'await db.$transaction(async (tx) => {',
      "  await tx.$queryRaw`SELECT id FROM t WHERE id IN (${a}) AND x = ')'`;",
      "  if (a) throw new Error('(unbalanced');",
      '}, POSTING_TX_OPTIONS);',
      'await db.$transaction([a(), b()]);',
      'await db.$transaction((tx) => f(tx));',
    ].join('\n');
    const calls = transactionCalls(src);
    expect(calls.map((c) => [c.line, c.interactive, c.args.includes('POSTING_TX_OPTIONS')])).toEqual([
      [1, true, true],
      [5, false, false],
      [6, true, false],
    ]);
  });

  it('passes POSTING_TX_OPTIONS to every interactive transaction of a posting service', () => {
    const missing: string[] = [];
    for (const f of postingFiles()) {
      for (const call of transactionCalls(read(f))) {
        if (call.interactive && !/,\s*POSTING_TX_OPTIONS\s*,?\s*$/.test(call.args)) missing.push(`${f}:${call.line}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // §10.1 step 12: a document locks all its (item, warehouse) projections in
  // one sorted pass before its first movement, never line by line. A movement
  // is applyMovement or applyTransfer; a body is a $transaction callback or a
  // method that runs on the caller's transaction (txMethodBodies).
  it('locks every stock document with lockForDocument before its first movement', () => {
    const MOVE = /\.apply(?:Movement|Transfer)\(/;
    const count = (text: string) => text.split(/\.apply(?:Movement|Transfer)\(/).length - 1;
    const unlocked: string[] = [];
    let documents = 0;
    let movesInTransactions = 0;
    let movesInSource = 0;
    for (const f of sourceFiles().filter((s) => !s.endsWith('/stock-ledger.service.ts'))) {
      const source = read(f);
      movesInSource += count(source);
      const bodies = [
        ...transactionCalls(source).map((c) => ({ line: c.line, text: c.args })),
        ...txMethodBodies(source).map((m) => ({ line: m.line, text: m.body })),
      ];
      for (const b of bodies) {
        const move = b.text.search(MOVE);
        if (move < 0) continue;
        documents += 1;
        movesInTransactions += count(b.text);
        const lock = b.text.indexOf('.lockForDocument(');
        if (lock < 0 || lock > move) unlocked.push(`${f}:${b.line}`);
      }
    }
    expect(documents).toBeGreaterThanOrEqual(9);
    // A movement written from a helper outside the transaction body would
    // escape this check: keep every applyMovement call inside one.
    expect(movesInTransactions).toBe(movesInSource);
    expect(unlocked).toEqual([]);
  });
});
