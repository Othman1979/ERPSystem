/**
 * Phase 7 — JoFotara e-invoicing (BUILD_PLAN §17 Phase 7 acceptance, docs/decisions/0005):
 *  - every document the system sends passes jofotara-kit's local validation;
 *  - a sales invoice and its returns are accepted by the local mock
 *    (there is no government sandbox) and get a QR;
 *  - no document is sent twice, even with two workers (two API processes);
 *  - UNKNOWN is never resent automatically; a manual resend sends the same XML;
 *  - the Secret-Key never appears in an API response, the audit log or the logs;
 *  - a rejection reaches the user with its message; buyer and reason rules;
 *  - tenant isolation.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 *
 * Timing: nothing here sleeps for a fixed time to "let the worker run". A wait
 * polls for the condition it needs, and "it was not resent" is shown by a later
 * document going through a worker pass that started after the first one settled
 * (afterWorkerPass). The knobs the timing depends on are the constants below,
 * handed to the API processes the suite spawns. Every test has a generous
 * timeout: jest's default of 5 s is shorter than the slowest of them needs
 * (3.7 s idle) once the machine is busy.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http, { type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { createMockServer, validate } from 'jofotara-kit';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

/** Ports are picked free at start-up, so two runs on one machine never meet on a port. */
let API_PORT = 0;
let API2_PORT = 0;
/** How often the in-API outbox worker runs, and how long an answer may take before a send is UNKNOWN. */
const WORKER_INTERVAL_MS = 250;
const HTTP_TIMEOUT_MS = 1500;
/** Jest's default of 5 s is too short for the tests that wait on the worker. */
const TEST_TIMEOUT_MS = 90_000;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const CLIENT_ID = `client-${RUN}`;
const SECRET = `secret-${RUN}-do-not-leak`;
const ENC_KEY = randomBytes(32).toString('base64');

let api1: ChildProcess;
let api2: ChildProcess | undefined;
let db: Connection;
let mock: Server;
let proxy: Server;
let proxyUrl = '';
const logs: string[] = [];

/** What the "JoFotara" side saw: one entry per request, by document UUID. */
const seen: string[] = [];
let mode: 'forward' | 'hang' | 'duplicate' = 'forward';

const api = (port = API_PORT) => request(`http://127.0.0.1:${port}`);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `ei-${RUN}-${Math.random().toString(36).slice(2)}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const slow = (name: string, fn: () => Promise<unknown>, timeoutMs = TEST_TIMEOUT_MS) => it(name, fn, timeoutMs);

/** Polls until `fn` returns something truthy. The deadline is reached only when the condition never comes. */
async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 45_000,
  what = 'the condition',
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

function startApi(port: number, worker: 'on' | 'off'): ChildProcess {
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  const child = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(port),
      NODE_ENV: 'test',
      EINVOICE_ENC_KEY: ENC_KEY,
      EINVOICE_WORKER: worker,
      EINVOICE_WORKER_INTERVAL_MS: String(WORKER_INTERVAL_MS),
      EINVOICE_HTTP_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
      // The unreachable case uses a .invalid host; anything else must be loopback.
      EINVOICE_SANDBOX_HOSTS: 'jofotara-down.invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => logs.push(String(d)));
  child.stderr?.on('data', (d) => {
    logs.push(String(d));
    process.stderr.write(`[api:${port}] ${d}`);
  });
  return child;
}

/** One run of the Cron command `einvoice-send` against erp_test (ADR-009 §15). */
async function runSendJob(): Promise<{ runs: number; claimed: number }> {
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  try {
    const { stdout, stderr } = await promisify(execFile)('node', ['dist/jobs/cli.js', 'einvoice-send'], {
      cwd: path.resolve(import.meta.dirname, '..', '..'),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'test',
        EINVOICE_ENC_KEY: ENC_KEY,
        EINVOICE_HTTP_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
        EINVOICE_SANDBOX_HOSTS: 'jofotara-down.invalid',
      },
    });
    logs.push(stdout, stderr);
    return JSON.parse(stdout) as { runs: number; claimed: number };
  } catch (err) {
    // execFile's message names only the command; the job's own output says why it failed.
    const { stdout = '', stderr = '' } = err as { stdout?: string; stderr?: string };
    logs.push(stdout, stderr);
    throw new Error(`einvoice-send failed: ${(err as Error).message}\n${stdout}\n${stderr}`.slice(0, 4000), { cause: err });
  }
}

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      try {
        return (await api(port).get('/api/v1/health')).status === 200;
      } catch {
        return false;
      }
    },
    timeoutMs,
    `the API on port ${port} to become healthy`,
    500, // anonymous requests have 100 a minute
  );
}

const uuidOf = (body: string) => {
  try {
    const xml = Buffer.from(JSON.parse(body).invoice as string, 'base64').toString('utf8');
    return /<cbc:UUID>([0-9a-f-]{36})<\/cbc:UUID>/.exec(xml)?.[1] ?? '?';
  } catch {
    return '?';
  }
};

/** Sits in front of the kit's mock to count requests and to fake a hang or a rejection. */
function startProxy(target: string): Promise<Server> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push(uuidOf(body));
    if (mode === 'hang') return; // never answers: the client times out → unknown
    const forward = () =>
      fetch(`${target}${req.url}`, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': String(req.headers['client-id'] ?? ''),
          'Secret-Key': String(req.headers['secret-key'] ?? ''),
        },
        body,
      });
    if (mode === 'duplicate') await forward(); // the mock records it, so the real answer is a duplicate rejection
    const answer = await forward();
    res.writeHead(answer.status, { 'Content-Type': answer.headers.get('content-type') ?? 'application/json' });
    res.end(await answer.text());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

beforeAll(async () => {
  API_PORT = await freePort();
  API2_PORT = await freePort();
  mock = createMockServer({ clientId: CLIENT_ID, secretKey: SECRET });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  const mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  proxy = await startProxy(mockUrl);
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  api1 = startApi(API_PORT, 'on');
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  const url = new URL(databaseUrl);
  db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'erp_test',
  });
  await waitForHealth(API_PORT);
}, 60_000);

afterAll(async () => {
  for (const p of [api1, api2]) {
    if (!p) continue;
    p.kill('SIGTERM');
    await once(p, 'exit').catch(() => undefined);
  }
  await db?.end();
  // Hang mode leaves requests open on purpose; close() would wait for them.
  proxy?.closeAllConnections();
  await new Promise((r) => proxy?.close(r));
  await new Promise((r) => mock?.close(r));
});

interface Submission {
  id: string;
  uuid: string;
  icv: number;
  status: string;
  documentNo: string;
  requestXml?: string | null;
  qrPayload?: string | null;
  errors?: { code: string; message: string; source: string }[] | null;
  attempts?: { attemptNo: number; outcome: string }[];
}

describe('Phase 7 — JoFotara', () => {
  let token = '';
  let tokenB = '';
  let tenantId: bigint;
  let warehouseId = '';
  let itemId = '';
  let cashAccountId = '';
  const party: Record<string, string> = {};
  let firstInvoice = { id: '', lineId: '' };
  let firstSubmission: Submission;

  const settingsBody = (over: object = {}) => ({
    environment: 'SANDBOX',
    baseUrl: proxyUrl,
    clientId: CLIENT_ID,
    incomeSourceSequence: '1234567',
    track: 'GENERAL_SALES',
    isEnabled: true,
    ...over,
  });

  async function draftInvoice(customer: string, qty: string, paymentType: 'CASH' | 'CREDIT' = 'CREDIT', price = '10.000') {
    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-03-10',
        customerId: party[customer],
        warehouseId,
        paymentType,
        ...(paymentType === 'CASH' ? { cashAccountId } : {}),
        lines: [{ itemId, qty, unitPrice: price }],
      });
    expect(inv.status).toBe(201);
    return { id: inv.body.id as string, lineId: (inv.body.lines as { id: string }[])[0].id };
  }

  const post = (kind: 'sales-invoices' | 'sales-returns', id: string) =>
    api().post(`/api/v1/${kind}/${id}/post`).set(auth(token)).set(idem());

  async function submissionOf(documentType: 'SALES_INVOICE' | 'SALES_RETURN', documentId: string) {
    const [row] = (await db.query(
      'SELECT id FROM einvoice_submissions WHERE tenant_id = ? AND document_type = ? AND document_id = ?',
      [tenantId, documentType, documentId],
    )) as { id: bigint }[];
    return row ? String(row.id) : undefined;
  }

  async function get(id: string): Promise<Submission> {
    const res = await api().get(`/api/v1/einvoice/submissions/${id}`).set(auth(token));
    expect(res.status).toBe(200);
    return res.body as Submission;
  }

  /**
   * Waits for the submission's status in the database, then reads it once through the API. Polling
   * the API instead would spend the signed-in user's request allowance (300 a minute, ADR-011),
   * and a slow run polls more, so it is the slow runs that would meet a 429.
   */
  async function settled(id: string, statuses = ['ACCEPTED', 'REJECTED', 'UNKNOWN', 'FAILED']): Promise<Submission> {
    await waitFor(
      async () => {
        const [row] = (await db.query('SELECT status FROM einvoice_submissions WHERE tenant_id = ? AND id = ?', [
          tenantId,
          id,
        ])) as { status: string }[];
        return row !== undefined && statuses.includes(row.status);
      },
      45_000,
      `submission ${id} to be ${statuses.join(' or ')}`,
    );
    return get(id);
  }

  /**
   * Proof that the outbox worker has run since "now", without sleeping: a new
   * invoice is posted and waited for until it is ACCEPTED. A worker run that
   * sends it started after everything already settled, so had that run found
   * an earlier submission due it would have taken it as well (rows are
   * claimed in id order, 20 at a time). Call it with the proxy answering.
   */
  async function afterWorkerPass(): Promise<void> {
    expect(mode).toBe('forward');
    const canary = await draftInvoice('TN', '1');
    expect((await post('sales-invoices', canary.id)).status).toBe(201);
    const id = await waitFor(() => submissionOf('SALES_INVOICE', canary.id), 45_000, 'the canary to be queued');
    expect((await settled(id)).status).toBe('ACCEPTED');
  }

  slow('setup', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `EI ${RUN}`, ownerName: 'Owner', email: `ei-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `EI B ${RUN}`, ownerName: 'Owner B', email: `eib-${RUN}@test.dev`, password: PASS });
    tokenB = regB.body.accessToken;
    tenantId = ((await db.query('SELECT id FROM tenants WHERE name = ?', [`EI ${RUN}`])) as { id: bigint }[])[0].id;

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    warehouseId = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    itemId = (
      await api().post('/api/v1/items').set(auth(token)).send({ code: 'SVC', nameAr: 'خدمة', baseUnitId: pcs, itemKind: 'SERVICE' })
    ).body.id;
    for (const [code, extra] of [
      ['TN', { taxNumber: '87654321' }],
      ['NIN', { nationalId: '9871234567' }],
      ['PN', { nationalId: '445566', nationalIdKind: 'PN' }],
      ['NONE', {}],
    ] as const) {
      const p = await api()
        .post('/api/v1/parties')
        .set(auth(token))
        .send({ code, nameAr: `عميل ${code}`, partyType: 'CUSTOMER', ...extra });
      expect(p.status).toBe(201);
      party[code] = p.body.id;
    }
    const accounts = await api().get('/api/v1/accounts').set(auth(token));
    const walk = (ns: { id: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        if (n.controlType === 'CASH' && !cashAccountId) cashAccountId = n.id;
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);
  });

  // ------------------------------------------------------------- settings

  slow('settings: enabling needs the seller and credentials; the secret is never returned', async () => {
    const before = await api().get('/api/v1/einvoice/settings').set(auth(token));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ isEnabled: false, hasSecret: false, environment: 'SANDBOX', encryptionKeySet: true });

    const notReady = await api().put('/api/v1/einvoice/settings').set(auth(token)).send(settingsBody());
    expect(notReady.status).toBe(400);
    expect(notReady.body.error.code).toBe('EINVOICE_NOT_READY');

    const toProd = await api()
      .put('/api/v1/einvoice/settings')
      .set(auth(token))
      .send(settingsBody({ baseUrl: 'https://backend.jofotara.gov.jo', isEnabled: false }));
    expect(toProd.status).toBe(400); // the sandbox may not point at production

    const saved = await api()
      .put('/api/v1/einvoice/settings')
      .set(auth(token))
      .send(settingsBody({ secretKey: SECRET, sellerTaxNumber: '12345678', sellerName: 'شركة الاختبار' }));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ isEnabled: true, hasSecret: true, clientId: CLIENT_ID, sellerTaxNumber: '12345678' });
    expect(JSON.stringify(saved.body)).not.toContain(SECRET);
    expect(JSON.stringify((await api().get('/api/v1/einvoice/settings').set(auth(token))).body)).not.toContain(SECRET);

    const [row] = (await db.query('SELECT secret_encrypted FROM einvoice_settings WHERE tenant_id = ?', [tenantId])) as {
      secret_encrypted: string;
    }[];
    expect(row.secret_encrypted.startsWith('v1.')).toBe(true);
    expect(row.secret_encrypted).not.toContain(SECRET);
    const audits = (await db.query('SELECT before_json, after_json FROM audit_logs WHERE tenant_id = ?', [tenantId])) as object[];
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  // ------------------------------------------------------ buyer / reason rules

  slow('a credit invoice needs a customer with a tax or national number', async () => {
    const inv = await draftInvoice('NONE', '1');
    const res = await post('sales-invoices', inv.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EINVOICE_BUYER_REQUIRED');
  });

  slow('a small cash sale to an unnamed customer goes as a walk-in buyer (TN 0)', async () => {
    const inv = await draftInvoice('NONE', '1', 'CASH');
    expect((await post('sales-invoices', inv.id)).status).toBe(201);
    const s = await settled((await waitFor(() => submissionOf('SALES_INVOICE', inv.id)))!);
    expect(s.status).toBe('ACCEPTED');
    expect(s.requestXml).toContain('<cbc:ID schemeID="TN">0</cbc:ID>');
  });

  slow('a non-Jordanian buyer goes with his personal number (PN)', async () => {
    const inv = await draftInvoice('PN', '1', 'CASH');
    expect((await post('sales-invoices', inv.id)).status).toBe(201);
    const s = await settled((await waitFor(() => submissionOf('SALES_INVOICE', inv.id)))!);
    expect(s.status).toBe('ACCEPTED');
    expect(s.requestXml).toContain('<cbc:ID schemeID="PN">445566</cbc:ID>');
  });

  // ------------------------------------------------------------ happy path

  slow('a posted credit invoice is queued, validated, sent once and accepted with a QR', async () => {
    firstInvoice = await draftInvoice('TN', '3');
    const posted = await post('sales-invoices', firstInvoice.id);
    expect(posted.status).toBe(201);
    expect(posted.body.einvoice).toMatchObject({ environment: 'SANDBOX' });
    expect(['PENDING', 'SENDING', 'ACCEPTED']).toContain(posted.body.einvoice.status);

    const id = (await submissionOf('SALES_INVOICE', firstInvoice.id))!;
    firstSubmission = await settled(id);
    expect(firstSubmission.status).toBe('ACCEPTED');
    expect(firstSubmission.qrPayload).toBeTruthy();
    expect(seen.filter((u) => u === firstSubmission.uuid)).toHaveLength(1);
    const report = validate(firstSubmission.requestXml!);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(firstSubmission.requestXml).toContain('name="022"');
    expect(firstSubmission.requestXml).not.toContain(SECRET);

    const view = await api().get(`/api/v1/sales-invoices/${firstInvoice.id}`).set(auth(token));
    expect(view.body.einvoice.status).toBe('ACCEPTED');
    expect(view.body.einvoice.qrPayload).toBe(firstSubmission.qrPayload);
  });

  slow('a return needs a reason, references the original and is accepted; so is a second one', async () => {
    const draft = (qty: string, reason?: string) =>
      api()
        .post('/api/v1/sales-returns')
        .set(auth(token))
        .send({
          returnDate: '2025-03-12',
          originalInvoiceId: firstInvoice.id,
          refundType: 'CREDIT',
          ...(reason ? { reason } : {}),
          lines: [{ originalLineId: firstInvoice.lineId, qty }],
        });
    const noReason = await draft('1');
    expect(noReason.status).toBe(201);
    const refused = await post('sales-returns', noReason.body.id);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('EINVOICE_REASON_REQUIRED');

    // The unposted draft above still holds 1 of the 3 sold.
    for (const qty of ['1', '1']) {
      const r = await draft(qty, 'إرجاع من العميل');
      expect(r.status).toBe(201);
      expect((await post('sales-returns', r.body.id)).status).toBe(201);
      const s = await settled((await waitFor(() => submissionOf('SALES_RETURN', r.body.id)))!);
      expect(s.status).toBe('ACCEPTED');
      expect(s.requestXml).toContain('<cbc:InvoiceTypeCode name="022">381</cbc:InvoiceTypeCode>');
      expect(s.requestXml).toContain(`<cbc:UUID>${firstSubmission.uuid}</cbc:UUID>`);
      expect(validate(s.requestXml!).findings.filter((f) => f.severity === 'error')).toEqual([]);
    }
  });

  // ---------------------------------------------------------- failure paths

  slow('a rejection is kept with its message and is not resent automatically', async () => {
    mode = 'duplicate';
    const inv = await draftInvoice('NIN', '1');
    expect((await post('sales-invoices', inv.id)).status).toBe(201);
    const s = await settled((await waitFor(() => submissionOf('SALES_INVOICE', inv.id)))!);
    mode = 'forward';
    expect(s.status).toBe('REJECTED');
    expect(s.errors?.length).toBeGreaterThan(0);
    expect(s.errors![0].message).toBeTruthy();
    const sentBefore = seen.filter((u) => u === s.uuid).length;
    expect(sentBefore).toBeGreaterThan(0);
    await afterWorkerPass(); // a worker run after the rejection: it must not have taken it again
    expect(seen.filter((u) => u === s.uuid).length).toBe(sentBefore);
    expect((await get(s.id)).status).toBe('REJECTED');
  });

  slow('an unanswered request is UNKNOWN, never resent on its own; a manual resend repeats the same XML', async () => {
    mode = 'hang';
    const inv = await draftInvoice('TN', '2');
    expect((await post('sales-invoices', inv.id)).status).toBe(201);
    const id = (await waitFor(() => submissionOf('SALES_INVOICE', inv.id)))!;
    const unknown = await settled(id);
    expect(unknown.status).toBe('UNKNOWN');
    mode = 'forward'; // from here an automatic resend would be answered, and seen
    await afterWorkerPass(); // a worker run after the timeout: it must not have taken it again
    expect(seen.filter((u) => u === unknown.uuid)).toHaveLength(1);
    expect((await get(id)).status).toBe('UNKNOWN');

    const resend = await api().post(`/api/v1/einvoice/submissions/${id}/resend`).set(auth(token)).set(idem());
    expect(resend.status).toBe(201);
    const accepted = await settled(id, ['ACCEPTED', 'REJECTED']);
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.uuid).toBe(unknown.uuid);
    expect(accepted.icv).toBe(unknown.icv);
    expect(accepted.requestXml).toBe(unknown.requestXml);
    expect(accepted.attempts?.map((a) => a.outcome)).toEqual(['unknown', 'accepted']);
  });

  slow('an unreachable server is FAILED with a retry planned, and recovers after a resend', async () => {
    // A new URL drops the stored secret, so it is sent again with each change.
    const put = (baseUrl: string) =>
      api().put('/api/v1/einvoice/settings').set(auth(token)).send(settingsBody({ baseUrl, secretKey: SECRET }));
    // .invalid never resolves (RFC 2606): the request cannot leave, so it is FAILED, not UNKNOWN.
    expect((await put('http://jofotara-down.invalid')).status).toBe(200);
    const inv = await draftInvoice('TN', '1');
    expect((await post('sales-invoices', inv.id)).status).toBe(201);
    const id = (await waitFor(() => submissionOf('SALES_INVOICE', inv.id)))!;
    const failed = await settled(id);
    expect((await put(proxyUrl)).status).toBe(200);
    expect(failed.status).toBe('FAILED');
    expect(failed.errors?.[0].code).toBe('UNREACHABLE');

    const resend = await api().post(`/api/v1/einvoice/submissions/${id}/resend`).set(auth(token)).set(idem());
    expect(resend.status).toBe(201);
    expect((await settled(id, ['ACCEPTED', 'REJECTED'])).status).toBe('ACCEPTED');
  });

  slow('two workers never send the same document twice', async () => {
    api2 = startApi(API2_PORT, 'on');
    await waitForHealth(API2_PORT);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const inv = await draftInvoice('TN', String(i + 1));
      expect((await post('sales-invoices', inv.id)).status).toBe(201);
      ids.push((await waitFor(() => submissionOf('SALES_INVOICE', inv.id)))!);
    }
    const done = await Promise.all(ids.map((id) => settled(id)));
    // The second process has done its part: it does not outlive this test and take work in the later ones.
    api2.kill('SIGTERM');
    await once(api2, 'exit').catch(() => undefined);
    api2 = undefined;
    for (const s of done) {
      expect(s.status).toBe('ACCEPTED');
      expect(seen.filter((u) => u === s.uuid)).toHaveLength(1);
    }
    // ICVs are unique and consecutive per company.
    const icvs = done.map((s) => s.icv).sort((a, b) => a - b);
    expect(new Set(icvs).size).toBe(icvs.length);
  }); // boots a second API process inside the test (default timeout: 90 s)

  slow('parallel postings each draw their own ICV', async () => {
    const drafts = await Promise.all([1, 2, 3, 4, 5].map((q) => draftInvoice('TN', String(q))));
    const posted = await Promise.all(drafts.map((d) => post('sales-invoices', d.id)));
    // Status with the error code, so a failure says why (e.g. a deadlock after posting's one retry).
    expect(posted.map((p) => `${p.status}${p.body?.error?.code ? ` ${p.body.error.code}` : ''}`)).toEqual(
      Array(5).fill('201'),
    );
    const icvs = (await db.query(
      `SELECT icv FROM einvoice_submissions WHERE tenant_id = ? AND document_type = 'SALES_INVOICE' AND document_id IN (?)`,
      [tenantId, drafts.map((d) => d.id)],
    )) as { icv: number }[];
    expect(new Set(icvs.map((r) => r.icv)).size).toBe(5);
    const ids = await Promise.all(drafts.map((d) => waitFor(() => submissionOf('SALES_INVOICE', d.id))));
    for (const s of await Promise.all(ids.map((id) => settled(id)))) expect(s.status).toBe('ACCEPTED');
  });

  slow('a 0% tax line needs its e-invoice code before the invoice can be posted', async () => {
    const taxes = (await api().get('/api/v1/tax-categories').set(auth(token))).body as { id: string; rate: string }[];
    const zero = taxes.find((t) => Number(t.rate) === 0)!;
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const exempt = await api()
      .post('/api/v1/items')
      .set(auth(token))
      .send({ code: 'EXEMPT', nameAr: 'معفى', baseUnitId: pcs, itemKind: 'SERVICE', taxCategoryId: zero.id });
    expect(exempt.status).toBe(201);
    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-03-10',
        customerId: party.TN,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: exempt.body.id, qty: '1', unitPrice: '3.000' }],
      });
    expect(inv.status).toBe(201);
    const refused = await post('sales-invoices', inv.body.id);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('EINVOICE_NOT_READY');

    expect((await api().patch(`/api/v1/tax-categories/${zero.id}`).set(auth(token)).send({ einvoiceCode: 'Z' })).status).toBe(200);
    expect((await post('sales-invoices', inv.body.id)).status).toBe(201);
    const s = await settled((await waitFor(() => submissionOf('SALES_INVOICE', inv.body.id)))!);
    expect(s.status).toBe('ACCEPTED');
    expect(s.requestXml).toContain('UN/ECE 5305">Z</cbc:ID>');
  });

  slow('the sandbox URL stays on this machine, and changing it drops the stored secret', async () => {
    const put = (body: object) => api().put('/api/v1/einvoice/settings').set(auth(token)).send(settingsBody(body));
    for (const baseUrl of ['https://attacker.example', 'http://backend.jofotara.gov.jo:443', 'http://10.0.0.5:8080']) {
      expect((await put({ baseUrl, isEnabled: false })).status).toBe(400);
    }
    // Another local port without the secret: the secret is dropped, so it cannot stay enabled.
    const moved = await put({ baseUrl: 'http://127.0.0.1:9', isEnabled: false });
    expect(moved.status).toBe(200);
    expect(moved.body.hasSecret).toBe(false);
    const enable = await put({ baseUrl: 'http://127.0.0.1:9' });
    expect(enable.status).toBe(400);
    expect(enable.body.error.code).toBe('EINVOICE_NOT_READY');
    // Back to the working mock with the secret.
    const back = await put({ secretKey: SECRET });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ isEnabled: true, hasSecret: true });
  });

  slow('the follow-up list counts by status; another tenant sees nothing', async () => {
    const list = await api().get('/api/v1/einvoice/submissions').set(auth(token));
    expect(list.status).toBe(200);
    expect(list.body.counts.ACCEPTED).toBeGreaterThanOrEqual(10);
    expect(list.body.counts.REJECTED).toBe(1);

    const b = await api().get('/api/v1/einvoice/submissions').set(auth(tokenB));
    expect(b.body.rows).toEqual([]);
    expect((await api().get(`/api/v1/einvoice/submissions/${firstSubmission.id}`).set(auth(tokenB))).status).toBe(404);
    expect(
      (await api().post(`/api/v1/einvoice/submissions/${firstSubmission.id}/resend`).set(auth(tokenB)).set(idem())).status,
    ).toBe(404);
    const bSettings = await api().get('/api/v1/einvoice/settings').set(auth(tokenB));
    expect(bSettings.body).toMatchObject({ isEnabled: false, hasSecret: false, clientId: null });
  });

  slow('the Cron command sends the outbox; two runs at once never send a document twice', async () => {
    // Restart without the in-process loop (the default now): only the command sends.
    for (const p of [api1, api2]) {
      if (!p) continue;
      p.kill('SIGTERM');
      await once(p, 'exit').catch(() => undefined);
    }
    api2 = undefined;
    api1 = startApi(API_PORT, 'off');
    await waitForHealth(API_PORT);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const inv = await draftInvoice('TN', String(i + 1));
      expect((await post('sales-invoices', inv.id)).status).toBe(201);
      ids.push((await waitFor(() => submissionOf('SALES_INVOICE', inv.id)))!);
    }
    // Nothing to wait for here: that nothing happens can only be watched for. Four
    // worker intervals would have been four chances for an in-process loop to send.
    await sleep(WORKER_INTERVAL_MS * 4);
    const waiting = (await db.query('SELECT status FROM einvoice_submissions WHERE id IN (?)', [ids])) as { status: string }[];
    expect(waiting.map((r) => r.status)).toEqual(Array(4).fill('PENDING'));

    const [a, b] = await Promise.all([runSendJob(), runSendJob()]);
    // erp_test is shared and the command is cross-tenant: it also takes other tenants' rows
    // that happen to be due (stale FAILED retries from earlier runs), so the total is at
    // least ours. That no document went twice is what `seen` shows next.
    expect(a.claimed + b.claimed).toBeGreaterThanOrEqual(ids.length);
    const done = await Promise.all(ids.map((id) => settled(id)));
    for (const s of done) {
      expect(s.status).toBe('ACCEPTED');
      expect(seen.filter((u) => u === s.uuid)).toHaveLength(1);
    }
    // Nothing of ours is left: another run finds none of our documents to send, and none is sent a second time.
    expect((await runSendJob()).runs).toBeGreaterThanOrEqual(1);
    const [{ n }] = (await db.query(
      "SELECT COUNT(*) AS n FROM einvoice_submissions WHERE tenant_id = ? AND status IN ('PENDING', 'SENDING')",
      [tenantId],
    )) as { n: bigint | number }[];
    expect(Number(n)).toBe(0);
    for (const s of done) expect(seen.filter((u) => u === s.uuid)).toHaveLength(1);
  }, 120_000);

  slow('the secret never reached the logs', async () => {
    expect(logs.join('')).not.toContain(SECRET);
  });
});
