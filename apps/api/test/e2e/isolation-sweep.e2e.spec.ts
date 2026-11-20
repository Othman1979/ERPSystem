/**
 * Phase 10.4 — tenant isolation sweep (ADR-010 §10.4, BUILD_PLAN §14-11).
 * Driven by the API's own OpenAPI document, so every route is covered:
 *  - company A creates one of each kind of record, named with a marker;
 *  - company B (an owner, all permissions) calls every route that takes an
 *    id with A's ids, with a valid body: the answer is 404 (403 for the
 *    platform console), never 2xx, 400 (a check before the tenant lookup),
 *    409 (that would tell the record's state) or 500;
 *  - B's lists, and every query parameter ending in Id fed with A's ids,
 *    never contain A's marker;
 *  - afterwards A's records are as they were;
 *  - a route with an id that this sweep cannot exercise must be listed in
 *    UNCOVERED with a reason: a new route fails until it is added.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import { testDatabaseUrl } from './support/test-db.js';

const API_PORT = 3217;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
/** In every name A gives: B must never see it. */
const MARK = `LEAK${RUN}`;

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `sweep-${RUN}-${Math.random().toString(36).slice(2)}` });

/**
 * Routes with an id the sweep cannot exercise, and why (reviewed 2026-11-13).
 * Each still has the tenant-scoped client and the static guards.
 */
const UNCOVERED: Record<string, string> = {
  'GET /api/v1/stock-transfers/{id}': 'needs two warehouses; the trial plan allows one',
  'DELETE /api/v1/stock-transfers/{id}': 'needs two warehouses; the trial plan allows one',
  'POST /api/v1/stock-transfers/{id}/post': 'needs two warehouses; the trial plan allows one',
  'POST /api/v1/stock-transfers/{id}/reverse': 'needs two warehouses; the trial plan allows one',
  'GET /api/v1/einvoice/submissions/{id}': 'needs JoFotara settings (covered by einvoice.e2e isolation)',
  'POST /api/v1/einvoice/submissions/{id}/resend': 'needs JoFotara settings (covered by einvoice.e2e isolation)',
  'POST /api/v1/bank-statements/{id}/import': 'multipart upload: the file check runs before the lookup, the sweep sends JSON',
};

type Op = { method: string; path: string; query: string[] };

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await api().get('/api/v1/health')).status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}

beforeAll(async () => {
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test', EINVOICE_WORKER: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
  }
});

/** Text of any response (JSON, text, or a binary body as latin1). */
function bodyText(res: request.Response): string {
  if (typeof res.text === 'string' && res.text.length) return res.text;
  if (Buffer.isBuffer(res.body)) return res.body.toString('latin1');
  return JSON.stringify(res.body ?? '');
}

describe('Tenant isolation sweep (ADR-010 §10.4)', () => {
  let a = '';
  let b = '';
  const id: Record<string, string> = {};
  let ops: Op[] = [];
  const bodies: Record<string, object> = {};

  const asA = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, body?: object) => {
    const r = api()[method](`/api/v1${url}`).set(auth(a)).set(idem());
    return body ? r.send(body) : r;
  };
  async function create(url: string, body: object, key: string): Promise<string> {
    const res = await asA('post', url, body);
    if (res.status !== 201) throw new Error(`setup ${url}: ${res.status} ${JSON.stringify(res.body)}`);
    id[key] = String(res.body.id);
    return id[key];
  }
  const post = async (url: string) => {
    const res = await asA('post', url, {});
    if (res.status !== 201) throw new Error(`setup ${url}: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  it('setup: company A with one of each kind of record, and company B', async () => {
    a = (
      await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `Sweep A ${MARK}`, ownerName: `Owner ${MARK}`, email: `sweep-a-${RUN}@test.dev`, password: PASS })
    ).body.accessToken;
    b = (
      await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `Sweep B ${RUN}`, ownerName: 'Owner B', email: `sweep-b-${RUN}@test.dev`, password: PASS })
    ).body.accessToken;
    expect(a && b).toBeTruthy();
    id.tenant = String((await asA('get', '/me')).body.currentTenant.tenantId);

    await create('/fiscal-years', { code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' }, 'fiscalYear');
    const year = (await asA('get', `/fiscal-years/${id.fiscalYear}`)).body as { periods: { id: string }[] };
    id.fiscalPeriod = String(year.periods[0].id);

    const flat: { id: string; code: string; controlType?: string; children?: unknown[] }[] = [];
    const walk = (ns: typeof flat) => ns.forEach((n) => (flat.push(n), n.children && walk(n.children as typeof flat)));
    walk((await asA('get', '/accounts')).body);
    const code = (c: string) => String(flat.find((x) => x.code === c)!.id);
    id.account = code('1101');
    id.bankAccountGl = code('1102');
    id.unit = String((await asA('get', '/units')).body.find((u: { code: string }) => u.code === 'PCS').id);
    id.taxCategory = String((await asA('get', '/tax-categories')).body[0].id);
    id.paymentMethod = String((await asA('get', '/payment-methods')).body[0].id);
    id.branch = String((await asA('get', '/branches')).body[0].id);
    const members = (await asA('get', '/users')).body as { id?: string; membershipId?: string }[];
    id.membership = String(members[0].membershipId ?? members[0].id);

    await create('/warehouses', { code: 'W', nameAr: `W ${MARK}` }, 'warehouse');
    await create('/item-groups', { code: 'G', nameAr: `G ${MARK}` }, 'itemGroup');
    await create('/items', { code: 'I', nameAr: `I ${MARK}`, baseUnitId: id.unit, itemKind: 'STOCK' }, 'item');
    // Phase 16 (ADR-031): a manufactured item with a draft bill of materials, for the /boms routes.
    await create('/items', { code: 'M', nameAr: `M ${MARK}`, baseUnitId: id.unit, itemKind: 'MANUFACTURED' }, 'manufacturedItem');
    await create('/boms', { itemId: id.manufacturedItem, outputQty: '1', lines: [{ componentItemId: id.item, qty: '1' }] }, 'bom');
    // Phase 16 part B: the version is activated so a production voucher can be drafted on it (ADR-031 §7).
    expect((await asA('post', `/boms/${id.bom}/activate`, {})).status).toBe(201);
    await create('/production-vouchers', { itemId: id.manufacturedItem, qty: '1', materialsWarehouseId: id.warehouse, voucherDate: '2026-04-02' }, 'productionVoucher');
    id.barcodeCode = `B${RUN}`;
    await create(`/items/${id.item}/barcodes`, { barcode: id.barcodeCode }, 'barcode');
    await create('/parties', { code: 'C', nameAr: `C ${MARK}`, partyType: 'CUSTOMER' }, 'customer');
    await create('/parties', { code: 'S', nameAr: `S ${MARK}`, partyType: 'SUPPLIER' }, 'supplier');
    await create('/cash-boxes', { code: 'CB', name: `CB ${MARK}`, accountId: id.account }, 'cashBox');
    await create('/bank-accounts', { bankName: `Bank ${MARK}`, accountId: id.bankAccountGl }, 'bankAccount');
    await create('/cost-centers', { code: 'CC', nameAr: `CC ${MARK}` }, 'costCenter');
    // Phase 23 (ADR-038): a company role, for the /roles/custom routes.
    await create('/roles/custom', { code: 'CLERK', nameAr: `R ${MARK}`, permissions: ['reports.view'] }, 'tenantRole');

    await create(
      '/stock-adjustments',
      { adjustmentDate: '2026-01-01', adjustmentType: 'OPENING', warehouseId: id.warehouse, description: MARK, lines: [{ itemId: id.item, qty: '10', unitCost: '4.500' }] },
      'adjustment',
    );
    await post(`/stock-adjustments/${id.adjustment}/post`);
    await create('/stock-counts', { countDate: '2026-02-01', warehouseId: id.warehouse, description: MARK }, 'stockCount');
    const count = (await asA('get', `/stock-counts/${id.stockCount}`)).body as { lines?: { id: string }[] };
    if (!count.lines?.length) throw new Error('setup: the stock count has no lines');
    id.stockCountLine = String(count.lines[0].id);

    const je = (amount: string) => ({
      entryDate: '2026-02-02',
      description: MARK,
      lines: [
        { accountId: id.account, debit: amount },
        { accountId: code('4101'), credit: amount },
      ],
    });
    await create('/journal-entries', je('10'), 'journalDraft');
    await create('/journal-entries', je('20'), 'journal');
    await post(`/journal-entries/${id.journal}/post`);

    const invoice = (qty: string) => ({
      invoiceDate: '2026-03-01',
      customerId: id.customer,
      warehouseId: id.warehouse,
      paymentType: 'CREDIT',
      lines: [{ itemId: id.item, qty, unitPrice: '10.000' }],
    });
    bodies.salesInvoice = invoice('1');
    await create('/sales-invoices', invoice('1'), 'salesDraft');
    const sale = await asA('post', '/sales-invoices', invoice('2'));
    id.salesInvoice = String(sale.body.id);
    await post(`/sales-invoices/${id.salesInvoice}/post`);
    await create(
      '/sales-returns',
      { returnDate: '2026-03-02', originalInvoiceId: id.salesInvoice, refundType: 'CREDIT', reason: MARK, lines: [{ originalLineId: sale.body.lines[0].id, qty: '1' }] },
      'salesReturn',
    );
    bodies.purchaseInvoice = {
      invoiceDate: '2026-03-03',
      supplierId: id.supplier,
      warehouseId: id.warehouse,
      paymentType: 'CREDIT',
      lines: [{ itemId: id.item, qty: '1', unitCost: '4.000' }],
    };
    const purchase = await asA('post', '/purchase-invoices', {
      invoiceDate: '2026-03-03',
      supplierId: id.supplier,
      warehouseId: id.warehouse,
      paymentType: 'CREDIT',
      supplierInvoiceNo: MARK.slice(0, 30),
      lines: [{ itemId: id.item, qty: '2', unitCost: '4.000' }],
    });
    id.purchaseInvoice = String(purchase.body.id);
    await post(`/purchase-invoices/${id.purchaseInvoice}/post`);
    await create(
      '/purchase-returns',
      { returnDate: '2026-03-04', originalInvoiceId: id.purchaseInvoice, warehouseId: id.warehouse, refundType: 'CREDIT', reason: MARK, lines: [{ originalLineId: purchase.body.lines[0].id, qty: '1' }] },
      'purchaseReturn',
    );
    await create(
      '/goods-notes',
      (bodies.goodsNote = { noteDate: '2026-03-05', warehouseId: id.warehouse, noteType: 'GRN', description: MARK, lines: [{ itemId: id.item, qty: '1', unitCost: '4.000' }] }),
      'goodsNote',
    );
    await create(
      '/receipts',
      {
        receiptDate: '2026-03-06',
        partyType: 'CUSTOMER',
        partyId: id.customer,
        cashAccountId: id.account,
        amount: '5.000',
        description: MARK,
        allocations: [{ documentType: 'SALES_INVOICE', documentId: id.salesInvoice, amount: '5.000' }],
      },
      'receipt',
    );
    // The receipt's detail carries its allocations (there is no list route for them).
    const allocations = ((await asA('get', `/receipts/${id.receipt}`)).body as { allocations?: { id: string }[] }).allocations ?? [];
    if (!allocations.length) throw new Error('setup: the receipt has no allocation');
    id.allocation = String(allocations[0].id);
    await create(
      '/payments',
      { paymentDate: '2026-03-07', partyType: 'SUPPLIER', partyId: id.supplier, cashAccountId: id.account, amount: '2.000', description: MARK },
      'payment',
    );
    await create(
      '/cash-transfers',
      { transferDate: '2026-03-08', fromAccountId: id.account, toAccountId: id.bankAccountGl, amount: '1.000', description: MARK },
      'cashTransfer',
    );
    // Phase 20 (ADR-035) and Phase 22 (ADR-037): a bank statement and a received cheque.
    await create(
      '/bank-statements',
      { bankAccountId: id.bankAccount, startDate: '2026-03-01', endDate: '2026-03-31', openingBalance: '0.000', closingBalance: '0.000' },
      'bankStatement',
    );
    await asA('post', '/receipts', {
      receiptDate: '2026-03-09',
      partyType: 'CUSTOMER',
      partyId: id.customer,
      amount: '3.000',
      description: MARK,
      cheque: { chequeNo: `SW-${RUN}`, bankName: 'Bank', dueDate: '2026-04-09' },
    });
    const cheques = (await asA('get', `/cheques?q=SW-${RUN}`)).body as { items?: { id: string }[] };
    if (!cheques.items?.length) throw new Error('setup: the cheque receipt made no cheque');
    id.cheque = String(cheques.items[0].id);

    // Phase 12 (ADR-025): A at FULL with an approved request, a received quote and a
    // draft order; B at FULL too, so B's writes reach the tenant lookup instead of the level gate.
    expect((await asA('patch', '/company', { procurementLevel: 'FULL' })).status).toBe(200);
    expect((await api().patch('/api/v1/company').set(auth(b)).send({ procurementLevel: 'FULL' })).status).toBe(200);
    bodies.purchaseRequest = { requestDate: '2026-04-01', notes: MARK, lines: [{ itemId: id.item, qty: '5' }] };
    const prq = await create('/purchase-requests', bodies.purchaseRequest, 'purchaseRequest');
    await post(`/purchase-requests/${prq}/submit`);
    const approvedRequest = (await post(`/purchase-requests/${prq}/approve`)).body as { lines: { id: string }[] };
    await create('/purchase-quotes', { requestId: prq, supplierId: id.supplier, quoteDate: '2026-04-01', notes: MARK }, 'purchaseQuote');
    await post(`/purchase-quotes/${id.purchaseQuote}/send`);
    const quoteLines = ((await asA('get', `/purchase-quotes/${id.purchaseQuote}`)).body as { lines: { id: string }[] }).lines;
    const received = await asA('post', `/purchase-quotes/${id.purchaseQuote}/receive`, { lines: [{ lineId: quoteLines[0].id, unitPrice: '3' }] });
    if (received.status !== 201) throw new Error(`setup receive: ${received.status} ${JSON.stringify(received.body)}`);
    bodies.purchaseOrder = {
      orderDate: '2026-04-02',
      supplierId: id.supplier,
      warehouseId: id.warehouse,
      notes: MARK,
      lines: [{ itemId: id.item, qty: '1', unitPrice: '3', requestLineId: approvedRequest.lines[0].id }],
    };
    await create('/purchase-orders', { ...bodies.purchaseOrder, requestId: prq }, 'purchaseOrder');
    // Phase 13 (ADR-026 §9): a draft issue request (FULL).
    bodies.issueRequest = { requestDate: '2026-04-03', warehouseId: id.warehouse, notes: MARK, lines: [{ itemId: id.item, qty: '1' }] };
    await create('/issue-requests', bodies.issueRequest, 'issueRequest');
    // Phase 14 (ADR-027): a draft quote and a draft sales order of A.
    bodies.salesQuote = { quoteDate: '2026-04-05', customerId: id.customer, description: MARK, lines: [{ itemId: id.item, qty: '1', unitPrice: '2' }] };
    await create('/sales-quotes', bodies.salesQuote, 'salesQuote');
    bodies.salesOrder = {
      orderDate: '2026-04-06',
      customerId: id.customer,
      warehouseId: id.warehouse,
      description: MARK,
      lines: [{ itemId: id.item, qty: '1', unitPrice: '2' }],
    };
    await create('/sales-orders', bodies.salesOrder, 'salesOrder');

    const doc = await api().get('/api/docs-json');
    expect(doc.status).toBe(200);
    const paths = doc.body.paths as Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    ops = Object.entries(paths).flatMap(([p, methods]) =>
      Object.entries(methods).map(([method, op]) => ({
        method: method.toUpperCase(),
        path: p,
        query: (op.parameters ?? []).filter((x) => x.in === 'query').map((x) => x.name),
      })),
    );
    expect(ops.length).toBeGreaterThan(150);
  }, 180_000);

  /** A's id for a path parameter, by route. */
  function paramsFor(p: string): Record<string, string> | null {
    const seg = p.replace('/api/v1/', '').split('/')[0];
    const byResource: Record<string, string | undefined> = {
      accounts: id.account,
      'fiscal-years': id.fiscalYear,
      'fiscal-periods': id.fiscalPeriod,
      units: id.unit,
      'tax-categories': id.taxCategory,
      'payment-methods': id.paymentMethod,
      branches: id.branch,
      'journal-entries': p.endsWith('/post') ? id.journalDraft : id.journal,
      parties: id.customer,
      'item-groups': id.itemGroup,
      items: id.item,
      'item-barcodes': id.barcode,
      warehouses: id.warehouse,
      'stock-adjustments': id.adjustment,
      'stock-counts': id.stockCount,
      'sales-invoices': p.endsWith('/post') ? id.salesDraft : id.salesInvoice,
      'sales-returns': id.salesReturn,
      'purchase-invoices': id.purchaseInvoice,
      'purchase-returns': id.purchaseReturn,
      'goods-notes': id.goodsNote,
      'cash-boxes': id.cashBox,
      'bank-accounts': id.bankAccount,
      receipts: id.receipt,
      payments: id.payment,
      allocations: id.allocation,
      'cash-transfers': id.cashTransfer,
      'bank-statements': id.bankStatement,
      cheques: id.cheque,
      'cost-centers': id.costCenter,
      roles: id.tenantRole,
      'purchase-requests': id.purchaseRequest,
      'purchase-quotes': id.purchaseQuote,
      'purchase-orders': id.purchaseOrder,
      'issue-requests': id.issueRequest,
      'sales-quotes': id.salesQuote,
      'sales-orders': id.salesOrder,
      boms: id.bom,
      'production-vouchers': id.productionVoucher,
    };
    const values: Record<string, string> = {};
    for (const [, name] of p.matchAll(/\{(\w+)\}/g)) {
      if (p.startsWith('/api/v1/admin/')) values[name] = name === 'code' ? 'TRIAL' : id.tenant;
      else if (name === 'membershipId') values[name] = id.membership;
      else if (name === 'lineId') values[name] = id.stockCountLine;
      else if (name === 'itemId') values[name] = id.item;
      else if (name === 'code' && p.includes('/items/barcode/')) values[name] = id.barcodeCode;
      else if (name === 'id' && byResource[seg]) values[name] = byResource[seg]!;
      else return null;
    }
    return values;
  }

  /** A valid body for each change, so the request reaches the tenant lookup. */
  function bodyFor(p: string): object {
    if (p.endsWith('/reverse')) return { reversalDate: '2026-04-01' };
    if (p.endsWith('/journal-entries/{id}/amend')) {
      return { entryDate: '2026-04-01', lines: [{ accountId: '1', debit: '1' }, { accountId: '2', credit: '1' }] };
    }
    if (/\/(receipts|payments)\/\{id\}\/amend$/.test(p)) return { voucherDate: '2026-04-01', amount: '1.000' };
    if (p.endsWith('/allocations')) return { auto: true };
    if (p.endsWith('/items/{id}/units')) return { units: [{ unitId: id.unit, factorToBase: '1' }] };
    if (p.endsWith('/items/{id}/barcodes')) return { barcode: `X${RUN}` };
    if (p.includes('/lines/{lineId}')) return { countedQty: '1' };
    if (p === '/api/v1/bank-statements/{id}') return { startDate: '2026-03-01', endDate: '2026-03-31', openingBalance: '0', closingBalance: '0' };
    if (p.endsWith('/bank-statements/{id}/lines')) return { lineDate: '2026-03-02', deposit: '1.000' };
    if (p.endsWith('/bank-statements/{id}/matches')) return { statementLineId: '1', journalLineIds: ['1'] };
    if (p.endsWith('/cheques/{id}/deposit')) return { date: '2026-04-01', bankAccountId: id.bankAccountGl };
    if (/\/cheques\/\{id\}\/(collect|clear|return|undo)$/.test(p)) return { date: '2026-04-01' };
    if (p.endsWith('/purchase-permissions')) return { permissions: [{ code: 'purchase.direct' }] };
    if (p === '/api/v1/roles/custom/{id}') return { code: 'CLERK', nameAr: 'x', permissions: ['reports.view'] };
    if (p === '/api/v1/sales-invoices/{id}') return bodies.salesInvoice;
    if (p === '/api/v1/purchase-invoices/{id}') return bodies.purchaseInvoice;
    if (p === '/api/v1/goods-notes/{id}') return bodies.goodsNote;
    // Phase 12: valid bodies, so B's change reaches the lookup of A's document.
    if (/\/purchase-(requests|quotes|orders)\/\{id\}\/(reject|cancel)$/.test(p)) return { reason: 'x' };
    if (p === '/api/v1/purchase-requests/{id}') return bodies.purchaseRequest;
    if (p === '/api/v1/purchase-quotes/{id}') return { supplierId: id.supplier, quoteDate: '2026-04-01' };
    if (p === '/api/v1/purchase-orders/{id}') return bodies.purchaseOrder;
    if (p.endsWith('/purchase-quotes/{id}/receive')) return { lines: [{ lineId: '1', unitPrice: '1' }] };
    if (p.endsWith('/purchase-requests/{id}/convert')) {
      return { orderDate: '2026-04-01', warehouseId: id.warehouse, selections: [{ quoteLineId: '1' }] };
    }
    // Phase 13 (ADR-026): valid bodies for the new changes.
    if (/\/(purchase-orders|issue-requests)\/\{id\}\/(reject|cancel|close)$/.test(p)) return { reason: 'x' };
    if (p === '/api/v1/issue-requests/{id}') return bodies.issueRequest;
    // Phase 14 (ADR-027): valid bodies for the sales quotes and orders.
    if (p === '/api/v1/sales-quotes/{id}') return bodies.salesQuote;
    if (p === '/api/v1/sales-orders/{id}') return bodies.salesOrder;
    if (/\/sales-(quotes|orders)\/\{id\}\/(reject|cancel|close|reject-approval)$/.test(p)) return { reason: 'x' };
    if (p.endsWith('/purchase-orders/{id}/receive') || p.endsWith('/issue-requests/{id}/issue')) return { noteDate: '2026-04-03' };
    // Phase 15 (ADR-030): valid bodies for the count lines and the scan.
    if (/\/stock-counts\/\{id\}\/lines$/.test(p)) return { itemId: id.item };
    if (p.endsWith('/stock-counts/{id}/scan')) return { barcode: `NOPE-${RUN}` };
    // Phase 16 (ADR-031): a valid replacement body for the draft update.
    if (p === '/api/v1/boms/{id}') return { outputQty: '1', lines: [{ componentItemId: id.item, qty: '1' }] };
    // Phase 16 part B (ADR-031 §7): a valid replacement body for the draft voucher update (no itemId: it is fixed).
    if (p === '/api/v1/production-vouchers/{id}') return { qty: '1', materialsWarehouseId: id.warehouse, voucherDate: '2026-04-02' };
    if (p.endsWith('/purchase-orders/{id}/bill')) {
      return { invoiceDate: '2026-04-03', paymentType: 'CREDIT', lines: [{ grnLineId: '1', qty: '1', unitCost: '1' }] };
    }
    return {};
  }

  const fill = (p: string, values: Record<string, string>) => p.replace(/\{(\w+)\}/g, (_, n: string) => values[n]);

  it("B reaches none of A's records through any route that takes an id", async () => {
    const withParams = ops.filter((o) => o.path.includes('{'));
    const uncovered: string[] = [];
    const wrong: string[] = [];
    let exercised = 0;
    for (const o of withParams) {
      const key = `${o.method} ${o.path}`;
      const values = paramsFor(o.path);
      if (!values) {
        if (!(key in UNCOVERED)) uncovered.push(key);
        continue;
      }
      if (key in UNCOVERED) continue;
      // The requirements preview takes a quantity: a valid one reaches the lookup.
      const url = fill(o.path, values) + (o.path.endsWith('/requirements') ? '?qty=1' : '');
      const req = api()[o.method.toLowerCase() as 'get'](url).set(auth(b)).set(idem());
      const res = o.method === 'GET' || o.method === 'DELETE' ? await req : await req.send(bodyFor(o.path));
      exercised += 1;
      // 400 is not a pass: it would mean a check fired before the tenant lookup was tried.
      const allowed = o.path.startsWith('/api/v1/admin/') ? [403] : [404];
      if (!allowed.includes(res.status) || bodyText(res).includes(MARK)) {
        wrong.push(`${key} → ${res.status} ${bodyText(res).slice(0, 160)}`);
      }
    }
    expect(uncovered).toEqual([]); // a new route: give it A's id above, or list it in UNCOVERED
    expect(wrong).toEqual([]);
    expect(exercised).toBeGreaterThan(70);
  }, 180_000);

  it("B gets 404 for A's order and invoice on the phase 14 invoicing routes (ADR-027 §4)", async () => {
    // Named explicitly on top of the generic walk above, so a rename of a route cannot drop them silently.
    const order = await api().get(`/api/v1/sales-orders/${id.salesOrder}/invoiceable`).set(auth(b));
    expect([order.status, bodyText(order).includes(MARK)]).toEqual([404, false]);
    const invoice = await api().post(`/api/v1/sales-orders/${id.salesOrder}/invoice`).set(auth(b)).set(idem()).send({});
    expect([invoice.status, bodyText(invoice).includes(MARK)]).toEqual([404, false]);
    const price = await api().post(`/api/v1/sales-invoices/${id.salesDraft}/approve-price`).set(auth(b)).set(idem()).send({});
    expect([price.status, bodyText(price).includes(MARK)]).toEqual([404, false]);
    const discountPreview = await api()
      .post('/api/v1/sales-invoices/preview')
      .set(auth(b))
      .send({ lines: [{ itemId: id.item, qty: '1', unitPrice: '10.000' }] });
    expect([discountPreview.status, bodyText(discountPreview).includes(MARK)]).toEqual([404, false]);
    const paths = ops.map((o) => `${o.method} ${o.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'GET /api/v1/sales-orders/{id}/invoiceable',
        'POST /api/v1/sales-orders/{id}/invoice',
        'POST /api/v1/sales-invoices/{id}/approve-price',
        'POST /api/v1/sales-invoices/preview',
        'GET /api/v1/fiscal-years/{id}/closing-preview',
        'POST /api/v1/fiscal-years/{id}/close',
        'POST /api/v1/fiscal-years/{id}/open',
      ]),
    );
  }, 60_000);

  it("B's lists, and every …Id query fed with A's ids, never show A's records", async () => {
    const byName: Record<string, string | undefined> = {
      accountId: id.account,
      partyId: id.customer,
      customerId: id.customer,
      supplierId: id.supplier,
      itemId: id.item,
      warehouseId: id.warehouse,
      fiscalYearId: id.fiscalYear,
      branchId: id.branch,
      cashAccountId: id.account,
      cashBoxId: id.cashBox,
      bankAccountId: id.bankAccount,
      documentId: id.salesInvoice,
      invoiceId: id.salesInvoice,
      costCenterId: id.costCenter,
      requestId: id.purchaseRequest,
      purchaseOrderId: id.purchaseOrder,
      issueRequestId: id.issueRequest,
      // Phase 17 (ADR-032 §6): the consumption report between two counts.
      fromCountId: id.stockCount,
      toCountId: id.stockCount,
    };
    const leaks: string[] = [];
    const unknown: string[] = [];
    let calls = 0;
    for (const o of ops.filter((x) => x.method === 'GET' && !x.path.includes('{'))) {
      const params = new URLSearchParams();
      for (const q of o.query) {
        if (byName[q]) params.set(q, byName[q]!);
        else if (/Id$/.test(q)) unknown.push(`${o.path}?${q}`);
      }
      if (o.query.includes('partyType')) params.set('partyType', 'CUSTOMER');
      if (o.query.includes('documentType')) params.set('documentType', 'SALES_INVOICE');
      const url = params.size ? `${o.path}?${params.toString()}` : o.path;
      const res = await api().get(url).set(auth(b));
      calls += 1;
      if (res.status >= 500 || bodyText(res).includes(MARK)) leaks.push(`GET ${url} → ${res.status} ${bodyText(res).slice(0, 160)}`);
    }
    expect(unknown).toEqual([]); // a new …Id query parameter: give it A's id in byName
    expect(leaks).toEqual([]);
    expect(calls).toBeGreaterThan(40);
  }, 180_000);

  it("A's records are as they were", async () => {
    const draft = await asA('get', `/journal-entries/${id.journalDraft}`);
    expect([draft.status, draft.body.status]).toEqual([200, 'DRAFT']);
    expect((await asA('get', `/sales-invoices/${id.salesDraft}`)).body.status).toBe('DRAFT');
    expect((await asA('get', `/sales-invoices/${id.salesInvoice}`)).body.status).toBe('POSTED');
    expect((await asA('get', `/parties/${id.customer}`)).body.isActive).toBe(true);
    expect((await asA('get', `/items/${id.item}`)).body.nameAr).toBe(`I ${MARK}`);
    expect((await asA('get', `/fiscal-years/${id.fiscalYear}`)).body.status).toBe('OPEN');
    expect((await asA('get', `/stock-adjustments/${id.adjustment}`)).body.status).toBe('POSTED');
    const receipt = (await asA('get', `/receipts/${id.receipt}`)).body as { status: string };
    expect(receipt.status).toBe('POSTED');
    const centres = (await asA('get', '/cost-centers')).body as { id: string; nameAr: string; isActive: boolean }[];
    expect(centres.find((c) => c.id === id.costCenter)).toMatchObject({ nameAr: `CC ${MARK}`, isActive: true });
  }, 60_000);
});
