/**
 * Phase 19 golden scenarios D1–D3 — invoice-level sales discounts (ADR-034).
 * Amounts are hand-derived below; existing golden files and their expected values are unchanged.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { Decimal } from 'decimal.js';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);

let boot: Booted;
let h: ReturnType<typeof kit>;

beforeAll(async () => {
  boot = await bootApi(3731);
  h = kit(boot.base, RUN);
}, 60_000);

afterAll(async () => {
  await stopApi(boot);
});

describe('Golden scenarios D1–D3 — invoice-level discount (ADR-034)', () => {
  let token = '';
  let tokenB = '';
  let tenantId: bigint;
  let warehouseId = '';
  let customerId = '';
  let supplierId = '';
  let x = '';
  let y = '';
  let service = '';
  const codes: Record<string, string> = {};

  async function setupPlan(name: string) {
    const [tenant] = (await boot.db.query('SELECT id FROM tenants WHERE name = ?', [name])) as { id: bigint }[];
    const plan = (await boot.db.query(
      `INSERT INTO plans (code, name_ar, name_en, max_users, max_branches, max_warehouses,
                          max_invoices_per_month, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 50, 50, 50, 100000, 1, NOW(3), NOW(3))`,
      [`D19-${RUN}-${name.endsWith('B') ? 'B' : 'A'}`, name, name],
    )) as { insertId: bigint };
    await boot.db.query('UPDATE tenants SET plan_id = ? WHERE id = ?', [plan.insertId, tenant.id]);
    return tenant.id;
  }

  async function postInvoice(body: {
    invoiceDate: string;
    customerId: string;
    warehouseId: string;
    paymentType: 'CREDIT';
    invoiceDiscountPct?: string;
    invoiceDiscountAmount?: string;
    lines: { itemId: string; qty: string; unitPrice: string; discountPct?: string }[];
  }) {
    const draft = h.ok(await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).send(body), 201, 'create invoice');
    const preview = h.ok(
      await h.api().post('/api/v1/sales-invoices/preview').set(h.auth(token)).send({
        ...(body.invoiceDiscountPct !== undefined ? { invoiceDiscountPct: body.invoiceDiscountPct } : {}),
        ...(body.invoiceDiscountAmount !== undefined ? { invoiceDiscountAmount: body.invoiceDiscountAmount } : {}),
        lines: body.lines,
      }),
      200,
      'preview invoice',
    ) as { invoiceDiscountAmount: string; netTotal: string; taxTotal: string; grandTotal: string };
    const posted = h.ok(await h.act(token, `sales-invoices/${draft.id}/post`), 201, 'post invoice') as {
      id: string;
      journalEntryId: string;
      invoiceDiscountPct: string | null;
      invoiceDiscountAmount: string;
      netTotal: string;
      taxTotal: string;
      grandTotal: string;
      lines: {
        id: string;
        discountAmount: string;
        invoiceDiscountShare: string;
        netAmount: string;
        taxAmount: string;
        lineTotal: string;
      }[];
    };
    return { ...posted, preview };
  }

  async function createReturn(invoiceId: string, lineId: string, qty: string) {
    return h.ok(
      await h.api().post('/api/v1/sales-returns').set(h.auth(token)).send({
        returnDate: '2025-03-05',
        originalInvoiceId: invoiceId,
        refundType: 'CREDIT',
        lines: [{ originalLineId: lineId, qty }],
      }),
      201,
      'create return',
    );
  }

  async function postReturn(invoiceId: string, lineId: string, qty: string) {
    const draft = await createReturn(invoiceId, lineId, qty);
    return h.ok(await h.act(token, `sales-returns/${draft.id}/post`), 201, 'post return') as {
      id: string;
      journalEntryId: string;
      netTotal: string;
      taxTotal: string;
      grandTotal: string;
      lines: { invoiceDiscountShare: string; netAmount: string; taxAmount: string; lineTotal: string }[];
    };
  }

  async function journalLines(entryId: string) {
    const body = h.ok(await h.get(token, `journal-entries/${entryId}`), 200, 'journal entry');
    return (body.lines as { account: { code: string }; debit: string; credit: string }[])
      .map((line) => `${line.account.code} ${new Decimal(line.debit).gt(0) ? `Dr ${m3(line.debit)}` : `Cr ${m3(line.credit)}`}`)
      .sort();
  }

  async function expectBalanced(entryId: string) {
    const body = h.ok(await h.get(token, `journal-entries/${entryId}`), 200, 'journal entry');
    const lines = body.lines as { debit: string; credit: string }[];
    const debit = lines.reduce((total, line) => total.plus(line.debit), new Decimal(0));
    const credit = lines.reduce((total, line) => total.plus(line.credit), new Decimal(0));
    expect(debit.eq(credit)).toBe(true);
  }

  async function salesDiscountDelta(entryIds: string[]) {
    const deltas = await Promise.all(entryIds.map(async (entryId) => {
      const body = h.ok(await h.get(token, `journal-entries/${entryId}`), 200, 'journal entry');
      return (body.lines as { account: { code: string }; debit: string; credit: string }[])
        .filter((line) => line.account.code === codes.SALES_DISCOUNTS)
        .reduce((total, line) => total.plus(line.debit).minus(line.credit), new Decimal(0));
    }));
    return deltas.reduce((total, value) => total.plus(value), new Decimal(0));
  }

  async function storedReturnNetShare(returnId: string) {
    const [row] = (await boot.db.query(
      'SELECT invoice_discount_net_share FROM sales_return_lines WHERE tenant_id = ? AND return_id = ?',
      [tenantId, BigInt(returnId)],
    )) as { invoice_discount_net_share: string }[];
    return new Decimal(row.invoice_discount_net_share);
  }

  async function verified() {
    const trialBalance = h.ok(await h.get(token, 'reports/trial-balance'), 200, 'trial balance');
    expect(trialBalance.balanced).toBe(true);
    const stock = h.ok(await h.get(token, 'stock/verify'), 200, 'stock verification');
    expect(stock.mismatches).toEqual([]);
  }

  async function purchase(itemId: string, qty: string, unitCost: string, invoiceDate = '2025-02-01') {
    const draft = h.ok(
      await h.api().post('/api/v1/purchase-invoices').set(h.auth(token)).send({
        invoiceDate,
        supplierId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId, qty, unitCost }],
      }),
      201,
      'create purchase',
    );
    h.ok(await h.act(token, `purchase-invoices/${draft.id}/post`), 201, 'post purchase');
  }

  it('setup: two stock items, a service item, tax 16%, company A and tenant B', async () => {
    const name = `GoldenDiscount ${RUN}`;
    const reg = await h.api().post('/api/v1/auth/register').send({
      tenantName: name,
      ownerName: 'Owner',
      email: `gd-${RUN}@test.dev`,
      password: PASS,
    });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    tenantId = await setupPlan(name);

    const regB = await h.api().post('/api/v1/auth/register').send({
      tenantName: `${name} B`,
      ownerName: 'Owner B',
      email: `gdb-${RUN}@test.dev`,
      password: PASS,
    });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;
    await setupPlan(`${name} B`);

    h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({
      code: '2025', startDate: '2025-01-01', endDate: '2025-12-31',
    }), 201, 'fiscal year');
    warehouseId = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(token)).send({
      code: 'W', nameAr: 'W',
    }), 201, 'warehouse').id as string;
    const units = h.ok(await h.get(token, 'units'), 200, 'units') as { id: string; code: string }[];
    const pcs = units.find((unit) => unit.code === 'PCS')!.id;
    const taxes = h.ok(await h.get(token, 'tax-categories'), 200, 'tax categories') as { id: string; rate: string }[];
    const tax16 = taxes.find((tax) => new Decimal(tax.rate).eq(16))!;
    const makeItem = async (code: string, itemKind: 'STOCK' | 'SERVICE') =>
      h.ok(await h.api().post('/api/v1/items').set(h.auth(token)).send({
        code, nameAr: code, baseUnitId: pcs, itemKind, taxCategoryId: tax16.id,
      }), 201, `item ${code}`).id as string;
    x = await makeItem('X', 'STOCK');
    y = await makeItem('Y', 'STOCK');
    service = await makeItem('S', 'SERVICE');
    customerId = h.ok(await h.api().post('/api/v1/parties').set(h.auth(token)).send({
      code: 'C', nameAr: 'C', partyType: 'CUSTOMER',
    }), 201, 'customer').id as string;
    supplierId = h.ok(await h.api().post('/api/v1/parties').set(h.auth(token)).send({
      code: 'S', nameAr: 'S', partyType: 'SUPPLIER',
    }), 201, 'supplier').id as string;
    await purchase(x, '10', '2');
    await purchase(y, '3', '3');
    const mappings = (await boot.db.query(
      `SELECT m.mapping_key AS k, a.code
         FROM account_mappings m JOIN accounts a ON a.id = m.account_id
        WHERE m.tenant_id = ?`,
      [tenantId],
    )) as { k: string; code: string }[];
    for (const row of mappings) codes[row.k] = row.code;
    expect(codes.SALES_DISCOUNTS).toBeDefined();
  });

  it('D1: a 10% tax-exclusive discount allocates 5.000 and 2.100 over the two sales lines', async () => {
    const invoice = await postInvoice({
      invoiceDate: '2025-02-02',
      customerId,
      warehouseId,
      paymentType: 'CREDIT',
      invoiceDiscountPct: '10',
      lines: [
        { itemId: x, qty: '10', unitPrice: '5.000' },
        { itemId: y, qty: '3', unitPrice: '7.000' },
      ],
    });
    // The live server preview is the authority used by the form: 63.900 net, 10.224 tax, 74.124 payable.
    expect([
      m3(invoice.preview.invoiceDiscountAmount),
      m3(invoice.preview.netTotal),
      m3(invoice.preview.taxTotal),
      m3(invoice.preview.grandTotal),
    ]).toEqual(['7.100', '63.900', '10.224', '74.124']);
    // 10×5=50.000 and 3×7=21.000; 10% = 7.100, allocated 5.000/2.100.
    // After discount: 45.000/18.900 net; 16% tax: 7.200/3.024; total: 52.200/21.924.
    expect(invoice.lines.map((line) => [
      m3(line.invoiceDiscountShare), m3(line.discountAmount), m3(line.netAmount), m3(line.taxAmount), m3(line.lineTotal),
    ])).toEqual([
      ['5.000', '5.000', '45.000', '7.200', '52.200'],
      ['2.100', '2.100', '18.900', '3.024', '21.924'],
    ]);
    // Invoice net 63.900, tax 10.224, payable 74.124; header percent is retained and amount is 7.100.
    expect([
      invoice.invoiceDiscountPct === null ? null : new Decimal(invoice.invoiceDiscountPct).toFixed(4),
      m3(invoice.invoiceDiscountAmount),
      m3(invoice.netTotal),
      m3(invoice.taxTotal),
      m3(invoice.grandTotal),
    ])
      .toEqual(['10.0000', '7.100', '63.900', '10.224', '74.124']);
    // Customer Dr 74.124; SALES Cr 71.000 before invoice discount; SALES_DISCOUNTS Dr 7.100; tax Cr 10.224;
    // stock cost is 10×2 + 3×3 = 29.000, so COGS Dr / Inventory Cr 29.000.
    expect(await journalLines(invoice.journalEntryId)).toEqual([
      `${codes.CUSTOMERS_CONTROL} Dr 74.124`,
      `${codes.SALES} Cr 71.000`,
      `${codes.SALES_DISCOUNTS} Dr 7.100`,
      `${codes.OUTPUT_TAX} Cr 10.224`,
      `${codes.COGS} Dr 29.000`,
      `${codes.INVENTORY} Cr 29.000`,
    ].sort());
    await verified();
  });

  it('D2: a fixed 0.002 discount on three equal tax-inclusive lines uses largest remainders', async () => {
    h.ok(await h.patchCompany(token, { pricesIncludeTax: true }), 200, 'enable tax-inclusive prices');
    const invoice = await postInvoice({
      invoiceDate: '2025-02-03',
      customerId,
      warehouseId,
      paymentType: 'CREDIT',
      invoiceDiscountAmount: '0.002',
      lines: [
        { itemId: service, qty: '1', unitPrice: '11.600' },
        { itemId: service, qty: '1', unitPrice: '11.600' },
        { itemId: service, qty: '1', unitPrice: '11.600' },
      ],
    });
    // Three equal 11.600 weights give exact shares 0.000667; all floor to 0.000 and the two 0.001
    // remainder units go to the first two tied lines: shares 0.001/0.001/0.000. Inclusive net is
    // 9.999/9.999/10.000, tax is 1.600 per line, and line totals are 11.599/11.599/11.600.
    expect(invoice.lines.map((line) => [
      m3(line.invoiceDiscountShare), m3(line.netAmount), m3(line.taxAmount), m3(line.lineTotal),
    ])).toEqual([
      ['0.001', '9.999', '1.600', '11.599'],
      ['0.001', '9.999', '1.600', '11.599'],
      ['0.000', '10.000', '1.600', '11.600'],
    ]);
    // Header discount is 0.002; net 29.998, tax 4.800, payable 34.798, unchanged by which equal line gets the remainder.
    expect([m3(invoice.invoiceDiscountAmount), m3(invoice.netTotal), m3(invoice.taxTotal), m3(invoice.grandTotal)])
      .toEqual(['0.002', '29.998', '4.800', '34.798']);
    // SALES remains 30.000 before the discount; the net-of-tax SALES_DISCOUNTS debit is 0.002.
    expect(await journalLines(invoice.journalEntryId)).toEqual([
      `${codes.CUSTOMERS_CONTROL} Dr 34.798`,
      `${codes.SALES} Cr 30.000`,
      `${codes.SALES_DISCOUNTS} Dr 0.002`,
      `${codes.OUTPUT_TAX} Cr 4.800`,
    ].sort());
    await verified();
    h.ok(await h.patchCompany(token, { pricesIncludeTax: false }), 200, 'restore tax-exclusive prices');
  });

  it('D3: partial and completing returns reclaim the exact discount share and return SALES_DISCOUNTS to zero', async () => {
    await purchase(y, '3', '3', '2025-03-01');
    const invoice = await postInvoice({
      invoiceDate: '2025-03-04',
      customerId,
      warehouseId,
      paymentType: 'CREDIT',
      invoiceDiscountPct: '10',
      lines: [{ itemId: y, qty: '3', unitPrice: '7.000' }],
    });
    // 3×7=21.000, discount 2.100, net 18.900, tax 3.024, total 21.924.
    expect([m3(invoice.invoiceDiscountAmount), m3(invoice.netTotal), m3(invoice.taxTotal), m3(invoice.grandTotal)])
      .toEqual(['2.100', '18.900', '3.024', '21.924']);
    const first = await postReturn(invoice.id, invoice.lines[0].id, '1');
    // A one-of-three return reclaims 0.700; its net 6.300, tax 1.008, total 7.308.
    expect([m3(first.lines[0].invoiceDiscountShare), m3(first.netTotal), m3(first.taxTotal), m3(first.grandTotal)])
      .toEqual(['0.700', '6.300', '1.008', '7.308']);
    const second = await postReturn(invoice.id, invoice.lines[0].id, '2');
    // The completing return takes the exact remaining 1.400; net 12.600, tax 2.016, total 14.616.
    expect([m3(second.lines[0].invoiceDiscountShare), m3(second.netTotal), m3(second.taxTotal), m3(second.grandTotal)])
      .toEqual(['1.400', '12.600', '2.016', '14.616']);
    // Sale debit 2.100 and return credits 0.700 + 1.400 cancel exactly for this invoice's entries.
    const discountDeltas = await Promise.all([invoice.journalEntryId, first.journalEntryId, second.journalEntryId].map(async (entryId) => {
      const body = h.ok(await h.get(token, `journal-entries/${entryId}`), 200, 'journal entry');
      return (body.lines as { account: { code: string }; debit: string; credit: string }[])
        .filter((line) => line.account.code === codes.SALES_DISCOUNTS)
        .reduce((total, line) => total.plus(line.debit).minus(line.credit), new Decimal(0));
    }));
    expect(m3(discountDeltas.reduce((total, value) => total.plus(value), new Decimal(0)))).toBe('0.000');
    await verified();
  });

  it('balances three one-unit tax-inclusive returns with a 0.002 invoice discount', async () => {
    h.ok(await h.patchCompany(token, { pricesIncludeTax: true }), 200, 'enable tax-inclusive prices');
    const invoice = await postInvoice({
      invoiceDate: '2025-03-06',
      customerId,
      warehouseId,
      paymentType: 'CREDIT',
      invoiceDiscountAmount: '0.002',
      lines: [{ itemId: service, qty: '3', unitPrice: '1.002' }],
    });
    // 3×1.002 = 3.006 inclusive; discount 0.002 leaves net 2.590, tax 0.414, payable 3.004.
    expect([m3(invoice.netTotal), m3(invoice.taxTotal), m3(invoice.grandTotal)])
      .toEqual(['2.590', '0.414', '3.004']);
    const returns: Awaited<ReturnType<typeof postReturn>>[] = [];
    for (let i = 0; i < 3; i += 1) {
      returns.push(await postReturn(invoice.id, invoice.lines[0].id, '1'));
    }
    for (const ret of returns) await expectBalanced(ret.journalEntryId);
    expect(m3(await salesDiscountDelta([
      invoice.journalEntryId,
      ...returns.map((ret) => ret.journalEntryId),
    ]))).toBe('0.000');
    await verified();
    h.ok(await h.patchCompany(token, { pricesIncludeTax: false }), 200, 'restore tax-exclusive prices');
  });

  it('rejects a discount above the line total, a percent with an amount, and a negative discount', async () => {
    const base = {
      invoiceDate: '2025-02-06',
      customerId,
      warehouseId,
      paymentType: 'CREDIT',
      lines: [{ itemId: service, qty: '1', unitPrice: '10.000' }],
    };
    for (const discount of [
      { invoiceDiscountAmount: '10.001' },
      { invoiceDiscountAmount: '1.000', invoiceDiscountPct: '10' },
      { invoiceDiscountPct: '-1' },
    ]) {
      const response = await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).send({ ...base, ...discount });
      expect([response.status, response.body.error.code]).toEqual([400, 'INVOICE_DISCOUNT_INVALID']);
    }
  });

  it('isolates preview invoice identifiers and item identifiers from tenant B', async () => {
    const invoice = await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).send({
      invoiceDate: '2025-02-07',
      customerId,
      warehouseId,
      paymentType: 'CREDIT',
      lines: [{ itemId: service, qty: '1', unitPrice: '10.000' }],
    });
    expect(invoice.status).toBe(201);
    const previewByInvoice = await h.api().post('/api/v1/sales-invoices/preview').set(h.auth(tokenB)).send({
      invoiceId: invoice.body.id,
      lines: [{ itemId: service, qty: '1', unitPrice: '10.000' }],
    });
    expect(previewByInvoice.status).toBe(404);
    const previewByItem = await h.api().post('/api/v1/sales-invoices/preview').set(h.auth(tokenB)).send({
      lines: [{ itemId: service, qty: '1', unitPrice: '10.000' }],
    });
    expect(previewByItem.status).toBe(404);
    expect(JSON.stringify(previewByItem.body)).not.toContain('GoldenDiscount');
  });
});
