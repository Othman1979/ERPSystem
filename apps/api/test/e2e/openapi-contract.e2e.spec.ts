/**
 * OpenAPI contract (PLAT-15). Two promises of the API document:
 *  1. coverage: every operation declares its success response with a real
 *     schema (status, and a body schema that is not an empty object); only
 *     the routes in NO_CONTENT answer 204 with no body;
 *  2. truth: real answers match the declared schema exactly, checked by
 *     common/openapi/schema-check.ts (undeclared keys fail, as do missing
 *     ones, numbers where strings are declared, and nulls where not nullable).
 * Part 2 calls a sample of routes from every module, including numbered
 * pages, keyset pages, a union and a file, for tenant A, and the lists of
 * tenant B. The server also runs the response audit (OPENAPI_RESPONSE_AUDIT),
 * which must record nothing: CI runs the whole e2e corpus with it on, so a
 * route the sample misses is still checked wherever a suite calls it.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import type { OpenAPIObject } from '@nestjs/swagger';
import { auditAnswer } from '../../src/common/openapi/response-audit.js';
import type { SchemaDocument, SchemaObject } from '../../src/common/openapi/schema-check.js';

const API_PORT = 3691;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const AUDIT_FILE = path.join(os.tmpdir(), `openapi-audit-${RUN}.jsonl`);

/**
 * Routes that answer 204 with no body. Every other operation must document a
 * body schema. Keep this list short and true: a route is here only if it sets
 * HttpStatus.NO_CONTENT.
 */
const NO_CONTENT = [
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/logout-all',
  'POST /api/v1/auth/change-password',
  'POST /api/v1/me/invitations/{membershipId}/decline',
  'POST /api/v1/client-errors',
];

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

let server: ChildProcess;
let db: Connection;
let doc: OpenAPIObject;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': randomUUID() });

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
  rmSync(AUDIT_FILE, { force: true });
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      API_DOCS: 'on',
      OPENAPI_RESPONSE_AUDIT: AUDIT_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  const url = new URL(databaseUrl);
  db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'erp_test',
  });
  await waitForHealth();
  const res = await api().get('/api/docs-json');
  expect(res.status).toBe(200);
  doc = res.body as OpenAPIObject;
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
  rmSync(AUDIT_FILE, { force: true });
});

// ------------------------------------------------------------- coverage

function resolveRef(schema: SchemaObject): SchemaObject {
  const name = schema.$ref?.replace('#/components/schemas/', '');
  return name ? ((doc as unknown as SchemaDocument).components?.schemas?.[name] ?? {}) : schema;
}

/** Why a body schema says nothing about the body, or null when it is a real schema. */
function emptiness(schema: SchemaObject | undefined): string | null {
  if (!schema) return 'no schema';
  const s = resolveRef(schema);
  if (s.oneOf || s.anyOf || s.allOf || s.enum) return null;
  if (s.type === 'array') return s.items ? emptiness(s.items) : 'array without items';
  if (s.type === 'string' || s.type === 'integer' || s.type === 'number' || s.type === 'boolean') return null;
  if (s.properties && Object.keys(s.properties).length > 0) return null;
  if (s.additionalProperties && s.additionalProperties !== true) return null;
  return `empty object schema ${JSON.stringify(s)}`;
}

describe('OpenAPI coverage', () => {
  it('every operation declares a success response with a body schema (or is a listed 204)', () => {
    const problems: string[] = [];
    const noContent: string[] = [];
    let operations = 0;
    for (const [route, item] of Object.entries(doc.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        operations++;
        const name = `${method.toUpperCase()} ${route}`;
        const success = Object.entries(op.responses ?? {}).filter(([code]) => /^2\d\d$/.test(code));
        if (success.length === 0) {
          problems.push(`${name}: no 2xx response`);
          continue;
        }
        for (const [code, response] of success) {
          if (code === '204') {
            noContent.push(name);
            continue;
          }
          const content = (response as { content?: Record<string, { schema?: SchemaObject }> }).content;
          if (!content || Object.keys(content).length === 0) {
            problems.push(`${name} ${code}: no body schema`);
            continue;
          }
          for (const [type, media] of Object.entries(content)) {
            const why = emptiness(media.schema);
            if (why) problems.push(`${name} ${code} ${type}: ${why}`);
          }
        }
      }
    }
    expect(operations).toBeGreaterThan(180);
    expect(problems).toEqual([]);
    expect(noContent.sort()).toEqual([...NO_CONTENT].sort());
  });

  it('no component schema has a property that is an untyped object', () => {
    const problems: string[] = [];
    const schemas = (doc as unknown as SchemaDocument).components?.schemas ?? {};
    for (const [name, schema] of Object.entries(schemas)) {
      for (const [prop, value] of Object.entries(schema.properties ?? {})) {
        const target = value.type === 'array' ? value.items : value;
        if (!target) {
          problems.push(`${name}.${prop}: array without items`);
          continue;
        }
        const s = target.$ref || target.allOf || target.oneOf ? null : target;
        if (s && s.type === 'object' && !s.properties && s.additionalProperties === undefined) {
          problems.push(`${name}.${prop}: untyped object`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('documents the error envelope as every operation’s default response', () => {
    const missing: string[] = [];
    for (const [route, item] of Object.entries(doc.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (op && !op.responses?.default) missing.push(`${method.toUpperCase()} ${route}`);
      }
    }
    expect(missing).toEqual([]);
    expect(doc.components?.schemas?.ErrorResponseDto).toBeDefined();
  });
});

// ---------------------------------------------------------------- truth

interface Call {
  token?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: object;
  idempotent?: boolean;
  status?: number;
}

/**
 * Calls `template` (an OpenAPI path) and checks the answer against the
 * document; returns the body. A wrong status throws with the API's error.
 */
async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', template: string, c: Call = {}) {
  const route = `/api/v1${template}`;
  const url = route.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = c.params?.[k];
    if (v === undefined) throw new Error(`no value for {${k}} in ${template}`);
    return encodeURIComponent(v);
  });
  let req = api()[method.toLowerCase() as 'get'](url);
  if (c.token) req = req.set(auth(c.token));
  if (c.idempotent) req = req.set(idem());
  if (c.query) req = req.query(c.query);
  const res = await (c.body ? req.send(c.body) : req);
  const expected = c.status ?? (method === 'POST' ? 201 : 200);
  if (res.status !== expected) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(res.body)}`);
  const contentType = String(res.headers['content-type'] ?? '');
  const json = contentType.includes('application/json');
  const problems = auditAnswer(doc, method, route, res.status, contentType || undefined, json ? { json: true, value: res.body } : { json: false });
  if (problems.length > 0) throw new Error(`${method} ${template} does not match its schema:\n  ${problems.join('\n  ')}`);
  return res.body as T;
}

async function registerTenant(label: string) {
  const email = `contract-${label}-${RUN}@test.dev`;
  const reg = await call<{ accessToken: string }>('POST', '/auth/register', {
    body: { tenantName: `Contract ${label} ${RUN}`, ownerName: 'Owner', email, password: PASS },
  });
  return { token: reg.accessToken, email };
}

interface AccountNode {
  id: string;
  code: string;
  controlType?: string | null;
  children?: AccountNode[];
}

describe('Real answers match their declared schemas', () => {
  let token = '';
  let tokenB = '';
  let email = '';
  let warehouseId = '';
  let itemId = '';
  let customerId = '';
  let supplierId = '';
  let cashAccountId = '';
  let salesInvoiceId = '';
  let receiptId = '';

  it('auth, me, company, branches, users, settings and fiscal years (tenant A)', async () => {
    ({ token, email } = await registerTenant('a'));
    await call('POST', '/auth/login', { body: { email, password: PASS }, status: 200 });
    await call('GET', '/me', { token });
    await call('GET', '/me/tenants', { token });
    await call('GET', '/company', { token });
    await call('GET', '/branches', { token });
    await call('GET', '/users', { token });
    await call('GET', '/users/roles', { token });
    await call('GET', '/me/invitations', { token });
    await call('POST', '/fiscal-years', { token, body: { code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' } });
    await call('GET', '/fiscal-years', { token });
    await call('GET', '/document-sequences', { token });
    await call('GET', '/payment-methods', { token });
    await call('GET', '/account-mappings', { token });
    const tree = await call<AccountNode[]>('GET', '/accounts', { token });
    const flat: AccountNode[] = [];
    const walk = (nodes: AccountNode[]) => nodes.forEach((n) => (flat.push(n), walk(n.children ?? [])));
    walk(tree);
    cashAccountId = flat.find((a) => a.controlType === 'CASH')!.id;
  });

  it('master data: warehouses, units, taxes, items, parties (numbered pages and a union)', async () => {
    warehouseId = (await call<{ id: string }>('POST', '/warehouses', { token, body: { code: 'W1', nameAr: 'رئيسي' } })).id;
    await call('GET', '/warehouses', { token });
    await call('GET', '/warehouses/{id}', { token, params: { id: warehouseId } });
    const units = await call<{ id: string; code: string }[]>('GET', '/units', { token });
    const taxes = await call<{ id: string; rate: string }[]>('GET', '/tax-categories', { token });
    const tax = taxes.find((t) => Number.parseInt(t.rate, 10) === 16)!;
    itemId = (
      await call<{ id: string }>('POST', '/items', {
        token,
        body: { code: 'A', nameAr: 'الصنف أ', baseUnitId: units.find((u) => u.code === 'PCS')!.id, taxCategoryId: tax.id },
      })
    ).id;
    await call('GET', '/items', { token });
    await call('GET', '/items/{id}', { token, params: { id: itemId } });
    // The Items page's edit body (apps/web/src/pages/items/itemPayload.ts, itemUpdateBody):
    // only UpdateItemDto fields. The page used to spread the form values, whose disabled
    // code, kind and base unit made every edit fail with 400; that body is still refused.
    await call('PATCH', '/items/{id}', {
      token,
      params: { id: itemId },
      body: { nameAr: 'الصنف أ', description: 'Note', taxCategoryId: tax.id, salePrice: '8.000', minStock: '0', salePriceIncludesTax: false },
    });
    const oldBody = await api()
      .patch(`/api/v1/items/${itemId}`)
      .set(auth(token))
      .send({ code: 'A', itemKind: 'STOCK', baseUnitId: units.find((u) => u.code === 'PCS')!.id, nameAr: 'الصنف أ' });
    expect(oldBody.status).toBe(400);
    expect(oldBody.body.error.code).toBe('VALIDATION');
    await call('GET', '/item-groups', { token });
    customerId = (await call<{ id: string }>('POST', '/parties', { token, body: { code: 'C', nameAr: 'عميل', partyType: 'CUSTOMER' } })).id;
    supplierId = (await call<{ id: string }>('POST', '/parties', { token, body: { code: 'S', nameAr: 'مورد', partyType: 'SUPPLIER' } })).id;
    await call('GET', '/parties', { token, query: { pageSize: '5' } });
    await call('GET', '/parties/{id}', { token, params: { id: customerId } });
    const spare = await call<{ id: string }>('POST', '/parties', { token, body: { code: 'X', nameAr: 'مؤقت', partyType: 'BOTH' } });
    // Unused, so deleted: one variant of the oneOf answer.
    await call('PATCH', '/parties/{id}/deactivate', { token, params: { id: spare.id } });
  });

  it('purchases and sales: draft, post, detail, list, pdf', async () => {
    const purchase = await call<{ id: string }>('POST', '/purchase-invoices', {
      token,
      body: { invoiceDate: '2025-01-05', supplierId, warehouseId, paymentType: 'CREDIT', lines: [{ itemId, qty: '10', unitCost: '5.000' }] },
    });
    await call('POST', '/purchase-invoices/{id}/post', { token, params: { id: purchase.id }, idempotent: true });
    const purchased = await call<{ warehouseId: string | null; lines: { id: string }[] }>('GET', '/purchase-invoices/{id}', {
      token,
      params: { id: purchase.id },
    });
    await call('GET', '/purchase-invoices', { token });
    // The purchase return form's body (PurchasesPage): the invoice's warehouse is required.
    // Before PLAT-15 the form never sent warehouseId, and every return was refused with 400.
    const ret = await call<{ id: string }>('POST', '/purchase-returns', {
      token,
      body: {
        returnDate: '2025-01-05',
        originalInvoiceId: purchase.id,
        warehouseId: purchased.warehouseId,
        refundType: 'CREDIT',
        lines: [{ originalLineId: purchased.lines[0].id, qty: '1' }],
      },
    });
    await call('GET', '/purchase-returns/{id}', { token, params: { id: ret.id } });

    const sale = await call<{ id: string }>('POST', '/sales-invoices', {
      token,
      body: { invoiceDate: '2025-01-06', customerId, warehouseId, paymentType: 'CREDIT', lines: [{ itemId, qty: '4', unitPrice: '8.000' }] },
    });
    salesInvoiceId = sale.id;
    await call('POST', '/sales-invoices/{id}/post', { token, params: { id: sale.id }, idempotent: true });
    await call('GET', '/sales-invoices/{id}', { token, params: { id: sale.id } });
    await call('GET', '/sales-invoices', { token });
    await call('GET', '/sales-returns', { token });
    await call('GET', '/purchase-returns', { token });
    await call('GET', '/goods-notes', { token });
    await call('GET', '/sales-invoices/{id}/pdf', { token, params: { id: sale.id } });
  });

  it('treasury: receipt with allocation, lists, balances, aging', async () => {
    const receipt = await call<{ id: string }>('POST', '/receipts', {
      token,
      idempotent: true,
      body: {
        receiptDate: '2025-01-10',
        partyType: 'CUSTOMER',
        partyId: customerId,
        cashAccountId,
        amount: '10.000',
        allocations: [{ documentType: 'SALES_INVOICE', documentId: salesInvoiceId, amount: '10.000' }],
      },
    });
    receiptId = receipt.id;
    await call('GET', '/receipts/{id}', { token, params: { id: receiptId } });
    await call('GET', '/receipts', { token });
    await call('GET', '/payments', { token });
    await call('GET', '/cash-boxes', { token });
    await call('GET', '/bank-accounts', { token });
    await call('GET', '/cash-transfers', { token });
    await call('GET', '/treasury/balances', { token });
    await call('GET', '/reports/aging', { token, query: { partyType: 'CUSTOMER' } });
  });

  it('inventory: balances, verify, stock documents, and the keyset movements and item card', async () => {
    await call('GET', '/stock/balances', { token });
    await call('GET', '/stock/item-balances', { token });
    await call('GET', '/stock/valuation', { token });
    await call('GET', '/stock/verify', { token });
    await call('GET', '/stock-adjustments', { token });
    await call('GET', '/stock-transfers', { token });
    await call('GET', '/stock-counts', { token });
    const first = await call<{ nextCursor: string | null }>('GET', '/stock/movements', { token, query: { itemId, limit: '1' } });
    expect(first.nextCursor).not.toBeNull();
    await call('GET', '/stock/movements', { token, query: { itemId, limit: '1', cursor: first.nextCursor! } });
    const card = await call<{ nextCursor: string | null }>('GET', '/stock/items/{itemId}/ledger', {
      token,
      params: { itemId },
      query: { limit: '1' },
    });
    // The second page: the summary is null there.
    await call('GET', '/stock/items/{itemId}/ledger', { token, params: { itemId }, query: { limit: '1', cursor: card.nextCursor! } });
  });

  it('journal and reports: entries page, ledger and statement keysets, statements, dashboard', async () => {
    await call('GET', '/journal-entries', { token });
    await call('GET', '/reports/trial-balance', { token });
    const ledger = await call<{ nextCursor: string | null }>('GET', '/reports/general-ledger', {
      token,
      query: { accountId: cashAccountId, from: '2025-01-01', to: '2025-12-31', limit: '1' },
    });
    if (ledger.nextCursor) {
      await call('GET', '/reports/general-ledger', {
        token,
        query: { accountId: cashAccountId, from: '2025-01-01', to: '2025-12-31', limit: '1', cursor: ledger.nextCursor },
      });
    }
    await call('GET', '/reports/party-statement', { token, query: { partyType: 'CUSTOMER', partyId: customerId, from: '2025-01-01', to: '2025-12-31' } });
    await call('GET', '/reports/income-statement', { token, query: { from: '2025-01-01', to: '2025-12-31' } });
    await call('GET', '/reports/balance-sheet', { token, query: { asOf: '2025-12-31' } });
    await call('GET', '/reports/tax-summary', { token, query: { from: '2025-01-01', to: '2025-12-31' } });
    await call('GET', '/reports/sales-summary', { token, query: { from: '2025-01-01', to: '2025-12-31' } });
    await call('GET', '/dashboard/summary', { token });
  });

  it('e-invoicing: settings and the submissions page with its counts', async () => {
    await call('GET', '/einvoice/settings', { token });
    await call('GET', '/einvoice/submissions', { token });
  });

  it('platform admin: tenants page, plans, errors', async () => {
    await db.query('UPDATE users SET is_platform_admin = 1 WHERE email = ?', [email]);
    const admin = await call<{ accessToken: string }>('POST', '/auth/login', { body: { email, password: PASS }, status: 200 });
    await call('GET', '/admin/tenants', { token: admin.accessToken, query: { q: `Contract a ${RUN}` } });
    await call('GET', '/admin/plans', { token: admin.accessToken });
    await call('GET', '/admin/errors', { token: admin.accessToken });
  });

  it('tenant B: its own lists match too, and hold none of A’s rows', async () => {
    ({ token: tokenB } = await registerTenant('b'));
    const parties = await call<{ items: unknown[]; total: number }>('GET', '/parties', { token: tokenB });
    expect(parties.total).toBe(0);
    const invoices = await call<{ items: unknown[] }>('GET', '/sales-invoices', { token: tokenB });
    expect(invoices.items).toEqual([]);
    await call('GET', '/parties/{id}', { token: tokenB, params: { id: customerId }, status: 404 });
  });

  it('the response audit recorded no mismatch', () => {
    const findings = existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, 'utf8').trim() : '';
    expect(findings).toBe('');
  });
});
