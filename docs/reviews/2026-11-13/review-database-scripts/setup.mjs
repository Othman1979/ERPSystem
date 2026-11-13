// Step 1-2: register the tenant, then create fiscal year, warehouses, items, parties.
import fs from 'node:fs';
import path from 'node:path';
import { BASE, DIR, api, setSession, saveCreds, randomPassword, progress, errorLog, short } from './lib.mjs';

const EMAIL = 'review-database-1@review.test';
const TENANT = 'Review review-database Volume';
const SETUP = path.join(DIR, 'setup.json');
const N_ITEMS = 200;
const N_CUSTOMERS = 50;
const N_SUPPLIERS = 20;

const log = (m) => {
  console.log(m);
  progress(m);
};

async function registerOrLoad() {
  if (fs.existsSync(path.join(DIR, 'creds.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(DIR, 'creds.json'), 'utf8'));
    if (c.email === EMAIL && c.password) {
      log('creds.json exists; reusing (no new register)');
      return c;
    }
  }
  const password = randomPassword();
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantName: TENANT, ownerName: 'Review Owner', email: EMAIL, password, locale: 'en' }),
  });
  const text = await res.text();
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register failed ${res.status}: ${short(text, 300)}`);
  }
  const body = JSON.parse(text);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => /^refresh_token=([^;]+)/.exec(c)?.[1]).find(Boolean);
  const creds = {
    email: EMAIL,
    password,
    tenantName: TENANT,
    tenantId: body.tenant?.id ?? body.tenantId ?? null,
    userId: body.user?.id ?? null,
    refreshToken: cookie ?? null,
    accessToken: body.accessToken,
  };
  saveCreds(creds);
  log(`registered tenant ${creds.tenantId ?? '(id not in body)'} keys=${Object.keys(body).join(',')}`);
  return creds;
}

async function main() {
  const creds = await registerOrLoad();
  setSession({ accessToken: creds.accessToken, refresh: creds.refreshToken });
  // Access token is short-lived; a refresh is done automatically on 401.
  const me = await api('GET', '/me');
  log(`GET /me -> ${me.status} ${short(me.text, 200)}`);
  const tenants = await api('GET', '/me/tenants');
  log(`GET /me/tenants -> ${tenants.status} ${short(tenants.text, 300)}`);

  const years = await api('GET', '/fiscal-years');
  log(`GET /fiscal-years -> ${years.status} ${short(years.text, 400)}`);
  const wh = await api('GET', '/warehouses');
  log(`GET /warehouses -> ${wh.status} ${short(wh.text, 400)}`);
  const units = await api('GET', '/units');
  log(`GET /units -> ${units.status} ${short(units.text, 400)}`);
  const accounts = await api('GET', '/accounts');
  log(`GET /accounts -> ${accounts.status} len=${accounts.text.length} ${short(accounts.text, 200)}`);
  const groups = await api('GET', '/item-groups');
  log(`GET /item-groups -> ${groups.status} ${short(groups.text, 200)}`);
  const tax = await api('GET', '/tax-categories');
  log(`GET /tax-categories -> ${tax.status} ${short(tax.text, 300)}`);
  const pm = await api('GET', '/payment-methods');
  log(`GET /payment-methods -> ${pm.status} ${short(pm.text, 200)}`);
  fs.writeFileSync(path.join(DIR, 'reference-dump.json'), JSON.stringify({ me: me.json, years: years.json, wh: wh.json, units: units.json, accounts: accounts.json, groups: groups.json, tax: tax.json }, null, 2));
}

main().catch((e) => {
  errorLog(`setup fatal ${e.stack ?? e}`);
  console.error(e);
  process.exit(1);
});
