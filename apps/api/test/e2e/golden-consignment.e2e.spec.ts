/**
 * Golden scenarios CS1–CS8 — BUILD_PLAN §18 and ADR-047.
 * Expected values are kept verbatim from the plan.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3791;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const CURRENT_DATE = new Date().toISOString().slice(0, 10);
const CURRENT_YEAR = CURRENT_DATE.slice(0, 4);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `cs-${RUN}-${Math.random().toString(36).slice(2)}` });
const m3 = (value: string | number | Decimal) => new Decimal(value).toFixed(3);
const d6 = (value: string | number | Decimal) => new Decimal(value).toFixed(6);

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await api().get('/api/v1/health')).status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

beforeAll(async () => {
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (data) => process.stderr.write(`[api] ${data}`));
  const url = new URL(databaseUrl);
  db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: TEST_DB_NAME,
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
  }
  await db?.end();
}, 60_000);

describe('Golden scenarios CS1–CS8 (ADR-047)', () => {
  let token = '';
  let tenantId = 0n;
  let companyId = 0n;
  let warehouse = '';
  let ownedWarehouse = '';
  let supplierId = '';
  let customerId = '';
  let cashAccountId = '';
  let itemId = '';
  let taxId = '';
  let saleId = '';
  let saleLineId = '';
  let settlementInvoiceId = '';
  let settlementLineId = '';
  let shortageSaleId = '';
  const companyName = `CS ${RUN}`;

  async function expectSuccess<T = Record<string, unknown>>(res: request.Response, status: number, label: string): Promise<T> {
    if (res.status !== status) throw new Error(`${label}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as T;
  }

  const post = (tokenValue: string, pathValue: string, body: object = {}) =>
    api().post(`/api/v1/${pathValue}`).set(auth(tokenValue)).set(idem()).send(body);
  const createAndPost = async (kind: string, body: object) => {
    const draft = await expectSuccess<{ id: string }>(
      await api().post(`/api/v1/${kind}`).set(auth(token)).send(body),
      201,
      `create ${kind}`,
    );
    return expectSuccess<Record<string, unknown>>(await post(token, `${kind}/${draft.id}/post`), 201, `post ${kind}`);
  };

  async function costPool(item: string, pool: string) {
    const rows = (await db.query(
      `SELECT total_qty AS qty, total_value AS value, avg_cost AS avg
         FROM item_costs
        WHERE tenant_id = ? AND company_id = ? AND item_id = ? AND pool_warehouse_id = ?`,
      [tenantId, companyId, item, pool],
    )) as { qty: string; value: string; avg: string }[];
    return rows.length ? { qty: d6(rows[0]!.qty), value: m3(rows[0]!.value), avg: d6(rows[0]!.avg) } : null;
  }

  async function balance(warehouseId: string, item: string) {
    const rows = (await db.query(
      `SELECT b.qty_on_hand AS qty
         FROM stock_balances b
         JOIN warehouses w ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
         JOIN items i ON i.tenant_id = b.tenant_id AND i.id = b.item_id
        WHERE b.tenant_id = ? AND w.company_id = ? AND i.company_id = ?
          AND b.warehouse_id = ? AND b.item_id = ?`,
      [tenantId, companyId, companyId, warehouseId, item],
    )) as { qty: string }[];
    return d6(rows[0]?.qty ?? '0');
  }

  async function journalLines(entryId: string) {
    const res = await api().get(`/api/v1/journal-entries/${entryId}`).set(auth(token));
    await expectSuccess(res, 200, `journal entry ${entryId}`);
    return (res.body.lines as { account: { code: string }; debit: string; credit: string; partyId?: string | null }[])
      .map((line) => ({
        code: line.account.code,
        debit: m3(line.debit),
        credit: m3(line.credit),
        partyId: line.partyId ?? null,
      }));
  }

  async function accountBalance(code: string) {
    const rows = (await db.query(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS balance
         FROM journal_lines l
         JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE e.tenant_id = ? AND e.company_id = ? AND e.status = 'POSTED' AND a.code = ?`,
      [tenantId, companyId, code],
    )) as { balance: string }[];
    return m3(rows[0]!.balance);
  }

  async function createSalesInvoice(
    warehouseId: string,
    item: string,
    qty: string,
    price: string,
    invoiceDate = '2025-02-10',
  ) {
    return expectSuccess<{ id: string; lines: { id: string }[] }>(
      await api().post('/api/v1/sales-invoices').set(auth(token)).send({
        invoiceDate,
        customerId,
        warehouseId,
        paymentType: 'CASH',
        cashAccountId,
        lines: [{ itemId: item, qty, unitPrice: price }],
      }),
      201,
      'create sales invoice',
    );
  }

  async function createSettlement(
    saleRowId: string,
    qty: string,
    unitPrice: string,
    invoiceDate = '2025-02-20',
  ) {
    return expectSuccess<{ id: string; lines: { id: string }[] }>(
      await api().post('/api/v1/purchase-invoices').set(auth(token)).send({
        invoiceDate,
        supplierId,
        warehouseId: warehouse,
        paymentType: 'CREDIT',
        consignmentSettlement: true,
        lines: [{ consignmentSaleId: saleRowId, qty, unitPrice, taxCategoryId: taxId }],
      }),
      201,
      'create settlement invoice',
    );
  }

  it('posts the CS1–CS8 golden flow with the specified cost pools and balances', async () => {
    const registration = await api().post('/api/v1/auth/register').send({
      tenantName: companyName,
      ownerName: 'Owner',
      email: `cs-${RUN}@test.dev`,
      password: PASS,
    });
    await expectSuccess(registration, 201, 'register');
    token = registration.body.accessToken as string;

    const fiscal = await api().post('/api/v1/fiscal-years').set(auth(token)).send({
      code: '2025',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    await expectSuccess(fiscal, 201, 'create fiscal year');
    if (CURRENT_YEAR !== '2025') {
      await expectSuccess(
        await api().post('/api/v1/fiscal-years').set(auth(token)).send({
          code: CURRENT_YEAR,
          startDate: `${CURRENT_YEAR}-01-01`,
          endDate: `${CURRENT_YEAR}-12-31`,
        }),
        201,
        'create current fiscal year',
      );
    }
    const companyResult = await api().patch('/api/v1/company').set(auth(token)).send({ consignmentEnabled: true });
    await expectSuccess(companyResult, 200, 'enable consignment');

    const ids = (await db.query(
      `SELECT t.id AS tenantId, c.id AS companyId
         FROM tenants t JOIN companies c ON c.tenant_id = t.id
        WHERE t.name = ?`,
      [companyName],
    )) as { tenantId: bigint; companyId: bigint }[];
    tenantId = ids[0]!.tenantId;
    companyId = ids[0]!.companyId;

    const units = await api().get('/api/v1/units').set(auth(token));
    const pieceId = (units.body as { id: string; code: string }[]).find((unit) => unit.code === 'PCS')!.id;
    const taxes = await api().get('/api/v1/tax-categories').set(auth(token));
    taxId = (taxes.body as { id: string; rate: string }[]).find((tax) => new Decimal(tax.rate).eq(16))!.id;
    supplierId = (await expectSuccess<{ id: string }>(
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S', nameAr: 'مورد', partyType: 'SUPPLIER' }),
      201,
      'create supplier',
    )).id;
    customerId = (await expectSuccess<{ id: string }>(
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C', nameAr: 'عميل', partyType: 'CUSTOMER' }),
      201,
      'create customer',
    )).id;
    ownedWarehouse = (await expectSuccess<{ id: string }>(
      await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W1', nameAr: 'مملوك' }),
      201,
      'create owned warehouse',
    )).id;
    const warehouseNow = new Date();
    const insertedWarehouse = (await db.query(
      `INSERT INTO warehouses
        (tenant_id, company_id, code, name_ar, is_active, consignment_supplier_id, created_at, updated_at)
       VALUES (?, ?, 'CW', 'أمانة', 1, ?, ?, ?)`,
      [tenantId, companyId, supplierId, warehouseNow, warehouseNow],
    )) as { insertId: bigint };
    warehouse = String(insertedWarehouse.insertId);
    itemId = (await expectSuccess<{ id: string }>(
      await api().post('/api/v1/items').set(auth(token)).send({
        code: 'A',
        nameAr: 'الصنف أ',
        baseUnitId: pieceId,
        taxCategoryId: taxId,
      }),
      201,
      'create item',
    )).id;
    const accountsResponse = await api().get('/api/v1/accounts').set(auth(token));
    const accounts: { id: string; controlType?: string; children?: unknown[] }[] = [];
    const collect = (rows: typeof accounts) => {
      for (const row of rows) {
        accounts.push(row);
        if (row.children) collect(row.children as typeof accounts);
      }
    };
    collect(accountsResponse.body as typeof accounts);
    cashAccountId = accounts.find((account) => account.controlType === 'CASH')!.id;

    const opening = await createAndPost('stock-adjustments', {
      adjustmentDate: '2025-02-01',
      adjustmentType: 'OPENING',
      warehouseId: ownedWarehouse,
      lines: [{ itemId, qty: '2', unitCost: '5.000' }],
    });
    expect(opening.journalEntryId).toBeDefined();
    const ownedPoolBefore = await costPool(itemId, '0');
    expect(ownedPoolBefore).toEqual({ qty: '2.000000', value: '10.000', avg: '5.000000' });
    const inventoryBefore = await accountBalance('1104');

    const receipt = await createAndPost('goods-notes', {
      noteDate: '2025-02-05',
      noteType: 'CONSIGNMENT_IN',
      warehouseId: warehouse,
      supplierId,
      lines: [{ itemId, qty: '10', unitCost: '20.000' }],
    });
    expect(receipt.journalEntryId).toBeNull();
    expect(await balance(warehouse, itemId)).toBe('10.000000');
    expect(await costPool(itemId, warehouse)).toEqual({ qty: '10.000000', value: '200.000', avg: '20.000000' });
    expect(await costPool(itemId, '0')).toEqual(ownedPoolBefore);
    expect(await accountBalance('1104')).toBe(inventoryBefore);
    const secondSupplier = (await expectSuccess<{ id: string }>(
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S2', nameAr: 'مورد ثان', partyType: 'SUPPLIER' }),
      201,
      'create second supplier',
    )).id;
    const changeSupplier = await api().patch(`/api/v1/warehouses/${warehouse}`).set(auth(token)).send({
      consignmentSupplierId: secondSupplier,
    });
    expect(changeSupplier.body.error.code).toBe('CONFLICT');
    const normalGrn = await api().post('/api/v1/goods-notes').set(auth(token)).send({
      noteDate: '2025-02-06',
      noteType: 'GRN',
      warehouseId: warehouse,
      lines: [{ itemId, qty: '1', unitCost: '20.000' }],
    });
    expect(normalGrn.body.error.code).toBe('CONSIGNMENT_WAREHOUSE_NOT_ALLOWED');
    const manualAdjustment = await api().post('/api/v1/stock-adjustments').set(auth(token)).send({
      adjustmentDate: '2025-02-06',
      adjustmentType: 'IN',
      warehouseId: warehouse,
      lines: [{ itemId, qty: '1', unitCost: '20.000' }],
    });
    expect(manualAdjustment.body.error.code).toBe('CONSIGNMENT_WAREHOUSE_NOT_ALLOWED');
    const transferDraft = await api().post('/api/v1/stock-transfers').set(auth(token)).send({
      transferDate: '2025-02-06',
      fromWarehouseId: warehouse,
      toWarehouseId: ownedWarehouse,
      lines: [{ itemId, qty: '1' }],
    });
    if (transferDraft.status === 201) {
      const transferPost = await post(token, `stock-transfers/${transferDraft.body.id}/post`);
      expect(transferPost.body.error.code).toBe('CONSIGNMENT_WAREHOUSE_NOT_ALLOWED');
      await expectSuccess(
        await api().delete(`/api/v1/stock-transfers/${transferDraft.body.id}`).set(auth(token)),
        200,
        'delete rejected transfer draft',
      );
    } else {
      expect(transferDraft.body.error.code).toBe('CONSIGNMENT_WAREHOUSE_NOT_ALLOWED');
    }
    const manufacturedItemId = (await expectSuccess<{ id: string }>(
      await api().post('/api/v1/items').set(auth(token)).send({
        code: 'MFG',
        nameAr: 'صنف تصنيع',
        baseUnitId: pieceId,
        itemKind: 'MANUFACTURED',
        taxCategoryId: taxId,
      }),
      201,
      'create manufactured item',
    )).id;
    const productionMaterialsGuard = await api().post('/api/v1/production-vouchers').set(auth(token)).send({
      itemId: manufacturedItemId,
      qty: '1',
      materialsWarehouseId: warehouse,
      outputWarehouseId: ownedWarehouse,
      voucherDate: '2025-02-06',
    });
    expect(productionMaterialsGuard.body.error.code).toBe('CONSIGNMENT_WAREHOUSE_NOT_ALLOWED');
    const productionOutputGuard = await api().post('/api/v1/production-vouchers').set(auth(token)).send({
      itemId: manufacturedItemId,
      qty: '1',
      materialsWarehouseId: ownedWarehouse,
      outputWarehouseId: warehouse,
      voucherDate: '2025-02-06',
    });
    expect(productionOutputGuard.body.error.code).toBe('CONSIGNMENT_WAREHOUSE_NOT_ALLOWED');
    const refuseDisableWithStock = await api().patch('/api/v1/company').set(auth(token)).send({ consignmentEnabled: false });
    expect(refuseDisableWithStock.body.error.code).toBe('CONSIGNMENT_IN_USE');

    const recipeItemId = (await expectSuccess<{ id: string }>(
      await api().post('/api/v1/items').set(auth(token)).send({
        code: 'REC',
        nameAr: 'صنف وصفة',
        baseUnitId: pieceId,
        itemKind: 'RECIPE',
        taxCategoryId: taxId,
      }),
      201,
      'create recipe item',
    )).id;
    const recipeInvoice = await createSalesInvoice(warehouse, recipeItemId, '1', '35.000');
    const recipePost = await post(token, `sales-invoices/${recipeInvoice.id}/post`);
    expect(recipePost.body.error.code).toBe('CONSIGNMENT_WAREHOUSE_NOT_ALLOWED');

    const sale = await createSalesInvoice(warehouse, itemId, '3', '35.000');
    saleId = sale.id;
    saleLineId = sale.lines[0]!.id;
    const salePosted = await expectSuccess<{ journalEntryId: string }>(
      await post(token, `sales-invoices/${sale.id}/post`),
      201,
      'post consignment sale',
    );
    const saleDetails = (await api().get(`/api/v1/sales-invoices/${sale.id}`).set(auth(token))).body as {
      netTotal: string;
      taxTotal: string;
      grandTotal: string;
    };
    expect({
      netTotal: m3(saleDetails.netTotal),
      taxTotal: m3(saleDetails.taxTotal),
      grandTotal: m3(saleDetails.grandTotal),
    }).toEqual({
      netTotal: '105.000',
      taxTotal: '16.800',
      grandTotal: '121.800',
    });
    expect(await journalLines(salePosted.journalEntryId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: '2111', credit: '60.000' }),
      expect.objectContaining({ code: '5101', debit: '60.000' }),
    ]));
    expect(await balance(warehouse, itemId)).toBe('7.000000');
    expect(await costPool(itemId, warehouse)).toEqual({ qty: '7.000000', value: '140.000', avg: '20.000000' });
    expect(await costPool(itemId, '0')).toEqual(ownedPoolBefore);
    const saleRows = (await db.query(
      `SELECT id, qty, value FROM consignment_sales
        WHERE tenant_id = ? AND company_id = ? AND source_type = 'SALES_INVOICE' AND source_line_id = ?`,
      [tenantId, companyId, saleLineId],
    )) as { id: bigint; qty: string; value: string }[];
    expect(saleRows).toHaveLength(1);
    saleId = String(saleRows[0]!.id);
    expect({ qty: d6(saleRows[0]!.qty), value: m3(saleRows[0]!.value) }).toEqual({ qty: '3.000000', value: '60.000' });

    const ownedSale = await createSalesInvoice(ownedWarehouse, itemId, '1', '35.000');
    const ownedSalePosted = await expectSuccess<{ id: string }>(
      await post(token, `sales-invoices/${ownedSale.id}/post`),
      201,
      'post owned-stock sale',
    );
    const ownedMovement = (await db.query(
      `SELECT unit_cost AS unitCost FROM stock_movements
        WHERE tenant_id = ? AND company_id = ? AND source_type = 'SALES_INVOICE'
          AND source_id = ? AND warehouse_id = ?`,
      [tenantId, companyId, ownedSale.id, ownedWarehouse],
    )) as { unitCost: string }[];
    expect(d6(ownedMovement[0]!.unitCost)).toBe('5.000000');
    expect(await costPool(itemId, '0')).toEqual({ qty: '1.000000', value: '5.000', avg: '5.000000' });
    expect(ownedSalePosted.id).toBe(ownedSale.id);

    const saleReturn = await expectSuccess<{ id: string }>(
      await api().post('/api/v1/sales-returns').set(auth(token)).send({
        returnDate: '2025-02-12',
        originalInvoiceId: sale.id,
        refundType: 'CASH',
        cashAccountId,
        lines: [{ originalLineId: saleLineId, qty: '1' }],
      }),
      201,
      'create sales return',
    );
    const saleReturnPosted = await expectSuccess<{ journalEntryId: string }>(
      await post(token, `sales-returns/${saleReturn.id}/post`),
      201,
      'post sales return',
    );
    expect(await journalLines(saleReturnPosted.journalEntryId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: '2111', debit: '20.000' }),
      expect.objectContaining({ code: '5101', credit: '20.000' }),
    ]));
    let saleRow = (await db.query('SELECT * FROM consignment_sales WHERE tenant_id = ? AND id = ?', [tenantId, saleId])) as {
      qty: string; value: string; returned_qty: string; returned_value: string; invoiced_qty: string; invoiced_value: string;
    }[];
    expect(saleRow[0]).toMatchObject({ returned_qty: '1.000000', returned_value: '20.000', invoiced_qty: '0.000000', invoiced_value: '0.000' });
    expect(await balance(warehouse, itemId)).toBe('8.000000');
    expect(await accountBalance('2111')).toBe('40.000');

    const settlementA = await createSettlement(saleId, '2', '21.000');
    const settlementB = await createSettlement(saleId, '2', '21.000');
    const settlementPosts = await Promise.all([
      post(token, `purchase-invoices/${settlementA.id}/post`),
      post(token, `purchase-invoices/${settlementB.id}/post`),
    ]);
    expect(settlementPosts.filter((result) => result.status === 201)).toHaveLength(1);
    const succeeded = settlementPosts.find((result) => result.status === 201);
    const rejected = settlementPosts.find((result) => result.status !== 201);
    expect(succeeded).toBeDefined();
    expect(rejected?.status).toBe(409);
    expect(rejected?.body.error.code).toBe('CONSIGNMENT_OVER_INVOICED');
    settlementInvoiceId = settlementPosts[0]!.status === 201 ? settlementA.id : settlementB.id;
    const rejectedSettlementId = settlementPosts[0]!.status === 201 ? settlementB.id : settlementA.id;
    await expectSuccess(await api().delete(`/api/v1/purchase-invoices/${rejectedSettlementId}`).set(auth(token)), 200, 'delete losing settlement draft');
    const settlement = (await api().get(`/api/v1/purchase-invoices/${settlementInvoiceId}`).set(auth(token))).body as {
      journalEntryId: string; lines: { id: string; consignmentClearedValue: string }[];
      netTotal: string; taxTotal: string; grandTotal: string;
    };
    settlementLineId = settlement.lines[0]!.id;
    expect({
      net: m3(settlement.netTotal),
      tax: m3(settlement.taxTotal),
      grand: m3(settlement.grandTotal),
      cleared: m3(settlement.lines[0]!.consignmentClearedValue),
    }).toEqual({ net: '42.000', tax: '6.720', grand: '48.720', cleared: '40.000' });
    expect(await journalLines(settlement.journalEntryId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: '2111', debit: '40.000' }),
      expect.objectContaining({ code: '5101', debit: '2.000' }),
      expect.objectContaining({ code: '1105', debit: '6.720' }),
      expect.objectContaining({ code: '2101', credit: '48.720', partyId: supplierId }),
    ]));
    expect(await balance(warehouse, itemId)).toBe('8.000000');
    expect(await accountBalance('2111')).toBe('0.000');
    saleRow = (await db.query('SELECT * FROM consignment_sales WHERE tenant_id = ? AND id = ?', [tenantId, saleId])) as typeof saleRow;
    expect(saleRow[0]).toMatchObject({ invoiced_qty: '2.000000', invoiced_value: '40.000' });

    const overReturn = await expectSuccess<{ id: string }>(
      await api().post('/api/v1/sales-returns').set(auth(token)).send({
        returnDate: '2025-02-22',
        originalInvoiceId: sale.id,
        refundType: 'CASH',
        cashAccountId,
        lines: [{ originalLineId: saleLineId, qty: '1' }],
      }),
      201,
      'create over-invoiced sales return',
    );
    const rejectedReturn = await post(token, `sales-returns/${overReturn.id}/post`);
    expect(rejectedReturn.body.error.code).toBe('CONSIGNMENT_ALREADY_INVOICED');
    await expectSuccess(await api().delete(`/api/v1/sales-returns/${overReturn.id}`).set(auth(token)), 200, 'delete rejected sales return');
    const anotherSettlement = await createSettlement(saleId, '1', '21.000');
    const rejectedSettlement = await post(token, `purchase-invoices/${anotherSettlement.id}/post`);
    expect(rejectedSettlement.body.error.code).toBe('CONSIGNMENT_OVER_INVOICED');
    await expectSuccess(await api().delete(`/api/v1/purchase-invoices/${anotherSettlement.id}`).set(auth(token)), 200, 'delete rejected settlement draft');

    const purchaseReturn = await expectSuccess<{ id: string }>(
      await api().post('/api/v1/purchase-returns').set(auth(token)).send({
        returnDate: '2025-02-25',
        originalInvoiceId: settlementInvoiceId,
        refundType: 'CREDIT',
        lines: [{ originalLineId: settlementLineId, qty: '1' }],
      }),
      201,
      'create settlement purchase return',
    );
    const purchaseReturnPosted = await expectSuccess<{ journalEntryId: string }>(
      await post(token, `purchase-returns/${purchaseReturn.id}/post`),
      201,
      'post settlement purchase return',
    );
    expect(await journalLines(purchaseReturnPosted.journalEntryId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: '2101', debit: '24.360', partyId: supplierId }),
      expect.objectContaining({ code: '2111', credit: '20.000' }),
      expect.objectContaining({ code: '5101', credit: '1.000' }),
      expect.objectContaining({ code: '1105', credit: '3.360' }),
    ]));
    saleRow = (await db.query('SELECT * FROM consignment_sales WHERE tenant_id = ? AND id = ?', [tenantId, saleId])) as typeof saleRow;
    expect(saleRow[0]).toMatchObject({ invoiced_qty: '1.000000', invoiced_value: '20.000' });
    expect(await accountBalance('2111')).toBe('20.000');

    const secondSaleReturn = await expectSuccess<{ id: string }>(
      await api().post('/api/v1/sales-returns').set(auth(token)).send({
        returnDate: '2025-03-01',
        originalInvoiceId: sale.id,
        refundType: 'CASH',
        cashAccountId,
        lines: [{ originalLineId: saleLineId, qty: '1' }],
      }),
      201,
      'create sales return after settlement return',
    );
    await expectSuccess(await post(token, `sales-returns/${secondSaleReturn.id}/post`), 201, 'post sales return after settlement return');
    expect(await balance(warehouse, itemId)).toBe('9.000000');
    saleRow = (await db.query('SELECT * FROM consignment_sales WHERE tenant_id = ? AND id = ?', [tenantId, saleId])) as typeof saleRow;
    expect(saleRow[0]).toMatchObject({
      returned_qty: '2.000000',
      returned_value: '40.000',
      invoiced_qty: '1.000000',
      invoiced_value: '20.000',
    });

    const count = await expectSuccess<{ id: string; lines: { id: string; itemId: string }[] }>(
      await api().post('/api/v1/stock-counts').set(auth(token)).send({
        countDate: '2025-03-30',
        warehouseId: warehouse,
        scope: 'ITEMS',
        itemIds: [itemId],
      }),
      201,
      'create stock count',
    );
    const countLine = count.lines.find((line) => line.itemId === itemId)!;
    await expectSuccess(
      await api().put(`/api/v1/stock-counts/${count.id}/lines/${countLine.id}`).set(auth(token)).send({ countedQty: '8' }),
      200,
      'count shortage',
    );
    await expectSuccess(await post(token, `stock-counts/${count.id}/submit`), 201, 'submit count');
    await expectSuccess(await post(token, `stock-counts/${count.id}/approve`), 201, 'approve count');
    expect(await balance(warehouse, itemId)).toBe('8.000000');
    expect(await accountBalance('5209')).toBe('-20.000');
    const shortages = (await db.query(
      `SELECT id, qty, value FROM consignment_sales
        WHERE tenant_id = ? AND company_id = ? AND source_type = 'STOCK_COUNT'`,
      [tenantId, companyId],
    )) as { id: bigint; qty: string; value: string }[];
    expect(shortages).toHaveLength(1);
    shortageSaleId = String(shortages[0]!.id);
    expect({ qty: d6(shortages[0]!.qty), value: m3(shortages[0]!.value) }).toEqual({ qty: '1.000000', value: '20.000' });
    expect(await accountBalance('2111')).toBe('20.000');

    const supplierReturn = await createAndPost('goods-notes', {
      noteDate: CURRENT_DATE,
      noteType: 'CONSIGNMENT_OUT',
      warehouseId: warehouse,
      supplierId,
      lines: [{ itemId, qty: '8' }],
    });
    expect(supplierReturn.journalEntryId).toBeNull();
    expect(await balance(warehouse, itemId)).toBe('0.000000');
    expect(await costPool(itemId, warehouse)).toMatchObject({ qty: '0.000000', value: '0.000' });
    expect(await accountBalance('2111')).toBe('20.000');
    expect(await accountBalance('1104')).toBe('-5.000');

    const itemB = (await expectSuccess<{ id: string }>(
      await api().post('/api/v1/items').set(auth(token)).send({
        code: 'B',
        nameAr: 'الصنف ب',
        baseUnitId: pieceId,
        taxCategoryId: taxId,
      }),
      201,
      'create concurrency item',
    )).id;
    await createAndPost('goods-notes', {
      noteDate: '2025-04-10',
      noteType: 'CONSIGNMENT_IN',
      warehouseId: warehouse,
      supplierId,
      lines: [{ itemId: itemB, qty: '7', unitCost: '20.000' }],
    });
    const raceA = await createSalesInvoice(warehouse, itemB, '5', '35.000', '2025-04-11');
    const raceB = await createSalesInvoice(warehouse, itemB, '5', '35.000', '2025-04-11');
    const racePosts = await Promise.all([
      post(token, `sales-invoices/${raceA.id}/post`),
      post(token, `sales-invoices/${raceB.id}/post`),
    ]);
    expect(racePosts.filter((result) => result.status === 201)).toHaveLength(1);
    expect(racePosts.find((result) => result.status !== 201)?.body.error.code).toBe('STOCK_INSUFFICIENT');
    const winningDraft = racePosts[0]!.status === 201 ? raceA : raceB;
    const losingDraft = racePosts[0]!.status === 201 ? raceB : raceA;
    await expectSuccess(
      await api().delete(`/api/v1/sales-invoices/${losingDraft.id}`).set(auth(token)),
      200,
      'delete losing sales draft',
    );
    const winningSaleRow = (await db.query(
      `SELECT id, qty, value FROM consignment_sales
        WHERE tenant_id = ? AND company_id = ? AND source_type = 'SALES_INVOICE' AND source_line_id = ?`,
      [tenantId, companyId, winningDraft.lines[0]!.id],
    )) as { id: bigint; qty: string; value: string }[];
    expect(winningSaleRow).toHaveLength(1);
    expect({ qty: d6(winningSaleRow[0]!.qty), value: m3(winningSaleRow[0]!.value) }).toEqual({
      qty: '5.000000',
      value: '100.000',
    });
    const raceSettlement = await createSettlement(String(winningSaleRow[0]!.id), '5', '20.000', '2025-04-12');
    await expectSuccess(await post(token, `purchase-invoices/${raceSettlement.id}/post`), 201, 'settle concurrency sale');
    await createAndPost('goods-notes', {
      noteDate: '2025-04-12',
      noteType: 'CONSIGNMENT_OUT',
      warehouseId: warehouse,
      supplierId,
      lines: [{ itemId: itemB, qty: '2' }],
    });
    expect(await balance(warehouse, itemB)).toBe('0.000000');

    const tenantBName = `CS B ${RUN}`;
    const tenantBRegistration = await api().post('/api/v1/auth/register').send({
      tenantName: tenantBName,
      ownerName: 'Owner B',
      email: `cs-b-${RUN}@test.dev`,
      password: PASS,
    });
    await expectSuccess(tenantBRegistration, 201, 'register tenant B');
    const tokenB = tenantBRegistration.body.accessToken as string;
    await expectSuccess(
      await api().patch('/api/v1/company').set(auth(tokenB)).send({ consignmentEnabled: true }),
      200,
      'enable consignment for tenant B',
    );
    const tenantBOpen = await api().get('/api/v1/consignment/open-sales').set(auth(tokenB));
    await expectSuccess(tenantBOpen, 200, 'tenant B open sales');
    expect(tenantBOpen.body).toEqual([]);
    const crossSupplier = await api()
      .get(`/api/v1/consignment/open-sales?supplierId=${supplierId}`)
      .set(auth(tokenB));
    expect(crossSupplier.status).toBe(404);
    const crossSettlement = await api().post('/api/v1/purchase-invoices').set(auth(tokenB)).send({
      invoiceDate: '2025-04-13',
      supplierId,
      warehouseId: warehouse,
      paymentType: 'CREDIT',
      consignmentSettlement: true,
      lines: [{ consignmentSaleId: shortageSaleId, qty: '1', unitPrice: '20.000', taxCategoryId: taxId }],
    });
    expect(crossSettlement.status).toBe(404);

    const secondCompany = await expectSuccess<{ id: string }>(
      await api().post('/api/v1/companies').set(auth(token)).send({
        legalNameAr: `شركة أمانة ثانية ${RUN}`,
        legalNameEn: `Consignment Company ${RUN}`,
      }),
      201,
      'create same-tenant company',
    );
    await expectSuccess(
      await api().patch('/api/v1/company').set(auth(token)).set('X-Company-Id', secondCompany.id).send({
        consignmentEnabled: true,
      }),
      200,
      'enable consignment for same-tenant company',
    );
    const sameTenantOpen = await api()
      .get('/api/v1/consignment/open-sales')
      .set(auth(token))
      .set('X-Company-Id', secondCompany.id);
    await expectSuccess(sameTenantOpen, 200, 'same-tenant company open sales');
    expect(sameTenantOpen.body).toEqual([]);
    const sameTenantCrossSupplier = await api()
      .get(`/api/v1/consignment/open-sales?supplierId=${supplierId}&warehouseId=${warehouse}`)
      .set(auth(token))
      .set('X-Company-Id', secondCompany.id);
    expect(sameTenantCrossSupplier.status).toBe(404);
    const sameTenantCrossSettlement = await api()
      .post('/api/v1/purchase-invoices')
      .set(auth(token))
      .set('X-Company-Id', secondCompany.id)
      .send({
        invoiceDate: '2025-04-13',
        supplierId,
        warehouseId: warehouse,
        paymentType: 'CREDIT',
        consignmentSettlement: true,
        lines: [{ consignmentSaleId: shortageSaleId, qty: '1', unitPrice: '20.000', taxCategoryId: taxId }],
      });
    expect(sameTenantCrossSettlement.status).toBe(404);

    const verify = await api().get('/api/v1/stock/verify').set(auth(token));
    await expectSuccess(verify, 200, 'stock verification');
    expect(verify.body.mismatches).toEqual([]);

    const totals = (await db.query(
      `SELECT COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
        WHERE e.tenant_id = ? AND e.company_id = ? AND e.status = 'POSTED'`,
      [tenantId, companyId],
    )) as { debit: string; credit: string }[];
    expect(m3(totals[0]!.debit)).toBe(m3(totals[0]!.credit));

    const countSettlement = await createSettlement(shortageSaleId, '1', '20.000');
    await expectSuccess(await post(token, `purchase-invoices/${countSettlement.id}/post`), 201, 'settle count shortage');
    expect(await accountBalance('2111')).toBe('0.000');
    const finalTotals = (await db.query(
      `SELECT COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
        WHERE e.tenant_id = ? AND e.company_id = ? AND e.status = 'POSTED'`,
      [tenantId, companyId],
    )) as { debit: string; credit: string }[];
    expect(m3(finalTotals[0]!.debit)).toBe(m3(finalTotals[0]!.credit));
    const disabled = await api().patch('/api/v1/company').set(auth(token)).send({ consignmentEnabled: false });
    await expectSuccess(disabled, 200, 'disable unused consignment');
    const disabledOpenSales = await api().get('/api/v1/consignment/open-sales').set(auth(token));
    expect(disabledOpenSales.body.error.code).toBe('CONSIGNMENT_DISABLED');
    const disabledReport = await api().get('/api/v1/reports/consignment-aging').set(auth(token));
    expect(disabledReport.body.error.code).toBe('CONSIGNMENT_DISABLED');
    const disabledNote = await api().post('/api/v1/goods-notes').set(auth(token)).send({
      noteDate: '2025-04-20',
      noteType: 'CONSIGNMENT_IN',
      warehouseId: warehouse,
      supplierId,
      lines: [{ itemId, qty: '1', unitCost: '20.000' }],
    });
    expect(disabledNote.body.error.code).toBe('CONSIGNMENT_DISABLED');
    const disabledWarehouseField = await api().patch(`/api/v1/warehouses/${warehouse}`).set(auth(token)).send({
      consignmentSupplierId: supplierId,
    });
    expect(disabledWarehouseField.body.error.code).toBe('CONSIGNMENT_DISABLED');
  });
});
