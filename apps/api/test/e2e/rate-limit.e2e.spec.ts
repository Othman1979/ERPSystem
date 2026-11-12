/**
 * Request limits (ADR-011):
 *  - a refused request says RATE_LIMITED (429), not INTERNAL;
 *  - sign-in counts per address and email, with a cap per address;
 *  - behind a trusted proxy (loopback by default) each client address counts on its own;
 *  - signed-in requests count per user, not per address.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';

const API_PORT = 3207;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;

const api = () => request(BASE);
const from = (address: string) => ({ 'X-Forwarded-For': address });
const login = (email: string, password: string, headers: Record<string, string> = {}) =>
  api().post('/api/v1/auth/login').set(headers).send({ email, password });

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
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

describe('Request limits (ADR-011)', () => {
  const a = `limit-a-${RUN}@test.dev`;
  const b = `limit-b-${RUN}@test.dev`;
  let tokenA = '';
  let tokenB = '';

  beforeAll(async () => {
    for (const [email, name] of [[a, 'Owner A'], [b, 'Owner B']] as const) {
      const res = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `Limit ${name} ${RUN}`, ownerName: name, email, password: PASS });
      expect(res.status).toBe(201);
      if (name === 'Owner A') tokenA = res.body.accessToken;
      else tokenB = res.body.accessToken;
    }
  });

  it('refuses the 11th sign-in a minute for one email with RATE_LIMITED', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login(a, 'wrong-password')).status).toBe(401);
    }
    const refused = await login(a, PASS);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after-account'])).toBeGreaterThan(0);
  });

  it('lets a colleague at the same address sign in', async () => {
    expect((await login(b, PASS)).status).toBe(200);
  });

  it('counts each address behind the proxy on its own', async () => {
    // The test connects over loopback, which TRUST_PROXY trusts by default.
    expect((await login(a, PASS, from('203.0.113.7'))).status).toBe(200);
    expect((await login(a.toUpperCase(), PASS, from('203.0.113.7'))).status).toBe(200);
  });

  it('caps one address at 30 sign-ins a minute across emails', async () => {
    const address = from('198.51.100.9');
    for (let i = 0; i < 30; i++) {
      expect((await login(`nobody-${i}-${RUN}@test.dev`, PASS, address)).status).toBe(401);
    }
    const refused = await login(b, PASS, address);
    expect([refused.status, refused.body.error.code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('counts signed-in requests per user, not per address', async () => {
    const me = (token: string) => api().get('/api/v1/me').set({ Authorization: `Bearer ${token}` });
    for (let batch = 0; batch < 5; batch++) {
      const statuses = (await Promise.all(Array.from({ length: 20 }, () => me(tokenA)))).map((r) => r.status);
      expect(statuses.every((s) => s === 200)).toBe(true);
    }
    const refused = await me(tokenA);
    expect([refused.status, refused.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect((await me(tokenB)).status).toBe(200);
  });
});
