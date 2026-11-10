/**
 * Phase 8 — printed documents (BUILD_PLAN §13.7, §15 `GET /sales-invoices/:id/pdf`):
 * sales invoice, sales return, purchase invoice, receipt and payment come
 * back as A4 PDFs with the Arabic font embedded; another tenant gets 404.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';

const API_PORT = 3205;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `pdf-${RUN}-${Math.random().toString(36).slice(2)}` });

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test', EINVOICE_WORKER: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await api().get('/api/v1/health')).status === 200) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

/** supertest buffers binary bodies with this parser. */
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function pdf(url: string, token: string) {
  return api().get(url).set(auth(token)).buffer(true).parse(binary);
}

function expectPdf(res: request.Response) {
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/pdf');
  expect(res.headers['content-disposition']).toMatch(/attachment; filename=".+\.pdf"/);
  const body = res.body as Buffer;
  expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // The Arabic font is embedded (as a subset: /BaseFont /ABCDEF+IBMPlexSansArabic…).
  expect(body.toString('latin1')).toMatch(/IBMPlexSansArabic/);
}

describe('Printed documents', () => {
  let token = '';
  let tokenB = '';
  const ids: Record<string, string> = {};

  it('setup: an invoice, a return, a purchase, a receipt and a payment', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `PDF ${RUN}`, ownerName: 'Owner', email: `pdf-${RUN}@test.dev`, password: PASS });
    token = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `PDF B ${RUN}`, ownerName: 'Owner B', email: `pdfb-${RUN}@test.dev`, password: PASS });
    tokenB = regB.body.accessToken;
    await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    const warehouseId = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'المستودع' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const itemId = (
      await api().post('/api/v1/items').set(auth(token)).send({ code: 'SVC', nameAr: 'خدمة صيانة (سنوية)', baseUnitId: pcs, itemKind: 'SERVICE' })
    ).body.id;
    const customer = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C', nameAr: 'عميل الاختبار', partyType: 'CUSTOMER' })).body.id;
    const supplier = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S', nameAr: 'مورد الاختبار', partyType: 'SUPPLIER' })).body.id;
    const accounts = await api().get('/api/v1/accounts').set(auth(token));
    let cashAccountId = '';
    const walk = (ns: { id: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        if (n.controlType === 'CASH' && !cashAccountId) cashAccountId = n.id;
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);

    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({ invoiceDate: '2025-03-10', customerId: customer, warehouseId, paymentType: 'CREDIT', lines: [{ itemId, qty: '2', unitPrice: '10.000' }] });
    ids.invoice = inv.body.id;
    ids.draftInvoice = (
      await api()
        .post('/api/v1/sales-invoices')
        .set(auth(token))
        .send({ invoiceDate: '2025-03-11', customerId: customer, warehouseId, paymentType: 'CREDIT', lines: [{ itemId, qty: '1', unitPrice: '5.000' }] })
    ).body.id;
    expect((await api().post(`/api/v1/sales-invoices/${ids.invoice}/post`).set(auth(token)).set(idem())).status).toBe(201);

    const ret = await api()
      .post('/api/v1/sales-returns')
      .set(auth(token))
      .send({ returnDate: '2025-03-12', originalInvoiceId: ids.invoice, refundType: 'CREDIT', reason: 'خدمة لم تُقدَّم', lines: [{ originalLineId: inv.body.lines[0].id, qty: '1' }] });
    ids.return = ret.body.id;
    expect((await api().post(`/api/v1/sales-returns/${ids.return}/post`).set(auth(token)).set(idem())).status).toBe(201);

    const pin = await api()
      .post('/api/v1/purchase-invoices')
      .set(auth(token))
      .send({ invoiceDate: '2025-03-05', supplierId: supplier, warehouseId, paymentType: 'CREDIT', supplierInvoiceNo: 'S-77', lines: [{ itemId, qty: '1', unitCost: '4.000' }] });
    ids.purchase = pin.body.id;

    const receipt = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set(idem())
      .send({
        receiptDate: '2025-03-15',
        partyType: 'CUSTOMER',
        partyId: customer,
        cashAccountId,
        amount: '5.000',
        allocations: [{ documentType: 'SALES_INVOICE', documentId: ids.invoice, amount: '5.000' }],
      });
    expect(receipt.status).toBe(201);
    ids.receipt = receipt.body.id;
    const payment = await api()
      .post('/api/v1/payments')
      .set(auth(token))
      .set(idem())
      .send({ paymentDate: '2025-03-16', partyType: 'SUPPLIER', partyId: supplier, cashAccountId, amount: '2.000' });
    expect(payment.status).toBe(201);
    ids.payment = payment.body.id;
  });

  it('each document prints as a PDF, in Arabic and in English', async () => {
    for (const url of [
      `/api/v1/sales-invoices/${ids.invoice}/pdf`,
      `/api/v1/sales-invoices/${ids.invoice}/pdf?lang=en`,
      `/api/v1/sales-invoices/${ids.draftInvoice}/pdf`,
      `/api/v1/sales-returns/${ids.return}/pdf`,
      `/api/v1/purchase-invoices/${ids.purchase}/pdf`,
      `/api/v1/receipts/${ids.receipt}/pdf`,
      `/api/v1/payments/${ids.payment}/pdf`,
    ]) {
      expectPdf(await pdf(url, token));
    }
  }, 60_000);

  it('a bad language is refused; another tenant gets 404', async () => {
    expect((await api().get(`/api/v1/sales-invoices/${ids.invoice}/pdf?lang=fr`).set(auth(token))).status).toBe(400);
    for (const url of [
      `/api/v1/sales-invoices/${ids.invoice}/pdf`,
      `/api/v1/sales-returns/${ids.return}/pdf`,
      `/api/v1/purchase-invoices/${ids.purchase}/pdf`,
      `/api/v1/receipts/${ids.receipt}/pdf`,
      `/api/v1/payments/${ids.payment}/pdf`,
    ]) {
      expect((await api().get(url).set(auth(tokenB))).status).toBe(404);
    }
  });
});
