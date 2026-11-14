/**
 * Phase 9.2 — company profile, logo and setup wizard state (§13.4, ADR-009):
 *  - GET / PATCH /company: names, digits-only tax number, blanks clear,
 *    tax-inclusive prices;
 *  - logo: PNG / JPEG by content, at most 1 MB, stored under STORAGE_DIR,
 *    replaced and removed with its file, shown in the PDF header;
 *  - onboarding completion keeps its first date;
 *  - tenant isolation (B never sees A's profile or logo).
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { testDatabaseUrl } from './support/test-db.js';

const API_PORT = 3209;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const STORAGE = mkdtempSync(path.join(os.tmpdir(), 'erp-storage-'));

/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** A JPEG signature (enough for the type check; never rendered). */
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

/** Files under the storage root (any tenant folder). */
const storedFiles = () =>
  readdirSync(STORAGE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(path.join(STORAGE, d.name)).map((f) => path.join(d.name, f)));

beforeAll(async () => {
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      STORAGE_DIR: STORAGE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  rmSync(STORAGE, { recursive: true, force: true });
});

describe('Phase 9.2 — company profile and setup state', () => {
  let token = '';
  let tokenB = '';

  const upload = (bytes: Buffer, filename: string, contentType: string, t = token) =>
    api().post('/api/v1/company/logo').set(auth(t)).attach('file', bytes, { filename, contentType });

  it('setup: tenants A and B', async () => {
    for (const tag of ['a', 'b']) {
      const res = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `CO ${tag} ${RUN}`, companyNameAr: `شركة ${tag}`, ownerName: 'Owner', email: `co-${tag}-${RUN}@test.dev`, password: PASS });
      expect(res.status).toBe(201);
      if (tag === 'a') token = res.body.accessToken;
      else tokenB = res.body.accessToken;
    }
    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
  });

  it('a new company has no setup date and no logo', async () => {
    const c = await api().get('/api/v1/company').set(auth(token));
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ legalNameAr: 'شركة a', onboardingCompletedAt: null, logo: null, pricesIncludeTax: false });
  });

  it('updates the profile: digits-only tax number, blanks clear a field', async () => {
    expect((await api().patch('/api/v1/company').set(auth(token)).send({ taxNumber: '12a' })).status).toBe(400);
    expect((await api().patch('/api/v1/company').set(auth(token)).send({ legalNameAr: '' })).status).toBe(400);
    expect((await api().patch('/api/v1/company').set(auth(token)).send({ tenantId: '1' })).status).toBe(400);

    const ok = await api()
      .patch('/api/v1/company')
      .set(auth(token))
      .send({ legalNameAr: ' شركة النور ', taxNumber: '123456789', address: 'عمّان', phone: '+962 6 000', pricesIncludeTax: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      legalNameAr: 'شركة النور',
      taxNumber: '123456789',
      address: 'عمّان',
      pricesIncludeTax: true,
    });
    const cleared = await api().patch('/api/v1/company').set(auth(token)).send({ phone: '  ' });
    expect(cleared.body.phone).toBeNull();
    expect(cleared.body.address).toBe('عمّان');
  });

  it('refuses logos that are not PNG / JPEG by content, or larger than 1 MB', async () => {
    const text = await upload(Buffer.from('not an image'), 'logo.png', 'image/png');
    expect(text.status).toBe(400);
    expect(text.body.error.code).toBe('UPLOAD_TYPE_NOT_ALLOWED');
    const big = await upload(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), 'big.png', 'image/png');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('UPLOAD_TOO_LARGE');
    expect((await api().post('/api/v1/company/logo').set(auth(token))).status).toBe(400);
    expect(storedFiles()).toEqual([]);
  });

  it('stores a logo, returns it, and puts it in the PDF header', async () => {
    const res = await upload(PNG, 'logo.png', 'image/png');
    expect(res.status).toBe(201);
    expect(res.body.logo).toMatchObject({ fileName: 'logo.png', mimeType: 'image/png' });
    expect(storedFiles()).toHaveLength(1);

    const logo = await api().get('/api/v1/company/logo').set(auth(token));
    expect(logo.status).toBe(200);
    expect(logo.body).toEqual({ mimeType: 'image/png', base64: PNG.toString('base64') });

    const pdf = await api()
      .get('/api/v1/reports/trial-balance?format=pdf')
      .set(auth(token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).toString('latin1')).toContain('/Subtype /Image');
  });

  it('replacing the logo removes the old file; removing it leaves no file', async () => {
    const before = storedFiles();
    const res = await upload(JPEG_HEAD, 'logo.jpg', 'image/jpeg');
    expect(res.status).toBe(201);
    expect(res.body.logo.mimeType).toBe('image/jpeg');
    const after = storedFiles();
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(existsSync(path.join(STORAGE, before[0]))).toBe(false);

    const removed = await api().delete('/api/v1/company/logo').set(auth(token));
    expect(removed.status).toBe(200);
    expect(removed.body.logo).toBeNull();
    expect(storedFiles()).toEqual([]);
    expect((await api().get('/api/v1/company/logo').set(auth(token))).status).toBe(404);
  });

  it('finishing the setup wizard keeps the first date', async () => {
    const first = await api().post('/api/v1/company/onboarding/complete').set(auth(token));
    expect(first.status).toBe(201);
    expect(first.body.onboardingCompletedAt).not.toBeNull();
    const again = await api().post('/api/v1/company/onboarding/complete').set(auth(token));
    expect(again.body.onboardingCompletedAt).toBe(first.body.onboardingCompletedAt);
  });

  it("tenant isolation: B sees its own company and never A's logo", async () => {
    await upload(PNG, 'a.png', 'image/png');
    const b = await api().get('/api/v1/company').set(auth(tokenB));
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ legalNameAr: 'شركة b', taxNumber: null, logo: null, onboardingCompletedAt: null });
    expect((await api().get('/api/v1/company/logo').set(auth(tokenB))).status).toBe(404);
    // A's files live in A's folder only.
    const folders = readdirSync(STORAGE);
    expect(folders).toHaveLength(1);
  });
});
