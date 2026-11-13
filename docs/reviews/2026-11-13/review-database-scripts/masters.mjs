// Step 2: fiscal years, warehouses, 200 stock items, 50 customers, 20 suppliers.
import fs from 'node:fs';
import path from 'node:path';
import { DIR, api, setSession, loadCreds, progress, errorLog, short } from './lib.mjs';

const log = (m) => {
  console.log(m);
  progress(m);
};
const pad = (n, w = 4) => String(n).padStart(w, '0');

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const creds = loadCreds();
  setSession({ accessToken: creds.accessToken, refresh: creds.refreshToken });
  const out = { tenantId: '1', warehouses: [], items: [], customers: [], suppliers: [] };

  // Fiscal years (2025 as the spec says "if possible"; the documents run in 2026).
  for (const [code, y] of [['FY2025', 2025], ['FY2026', 2026]]) {
    const r = await api('POST', '/fiscal-years', {
      body: { code, startDate: `${y}-01-01`, endDate: `${y}-12-31` },
    });
    log(`POST /fiscal-years ${code} -> ${r.status} ${short(r.text, 200)}`);
    if (r.status >= 400) errorLog(`fiscal ${code} ${r.status} ${short(r.text, 300)}`);
  }

  // Warehouses: the TRIAL plan allows maxWarehouses = 1. Try the 2nd to confirm.
  const whDefs = [
    { code: 'WH-A', nameAr: 'المستودع الرئيسي', nameEn: 'Main warehouse' },
    { code: 'WH-B', nameAr: 'مستودع ثان', nameEn: 'Second warehouse' },
  ];
  for (const w of whDefs) {
    const r = await api('POST', '/warehouses', { body: w });
    log(`POST /warehouses ${w.code} -> ${r.status} ${short(r.text, 300)}`);
    if (r.status === 201 || r.status === 200) {
      out.warehouses.push({ id: r.json.id, code: w.code });
    } else {
      errorLog(`warehouse ${w.code} ${r.status} ${short(r.text, 300)}`);
    }
  }

  // Items: 200 STOCK items, base unit PCS (id 99).
  const itemTasks = [];
  for (let i = 1; i <= 200; i++) {
    itemTasks.push(async () => {
      const r = await api('POST', '/items', {
        body: {
          code: `ITM-${pad(i)}`,
          nameAr: `صنف ${pad(i)}`,
          nameEn: `Item ${pad(i)}`,
          itemKind: 'STOCK',
          baseUnitId: '1',
        },
      });
      if (r.status === 201 || r.status === 200) return { id: r.json.id, code: `ITM-${pad(i)}` };
      errorLog(`item ITM-${pad(i)} ${r.status} ${short(r.text, 300)}`);
      return null;
    });
  }
  out.items = (await runPool(itemTasks, 4)).filter(Boolean);
  log(`items created: ${out.items.length}/200`);

  // Parties: 50 customers, 20 suppliers.
  const partyTasks = [];
  for (let i = 1; i <= 50; i++) {
    partyTasks.push(async () => {
      const r = await api('POST', '/parties', {
        body: { code: `CUS-${pad(i)}`, nameAr: `زبون ${pad(i)}`, nameEn: `Customer ${pad(i)}`, partyType: 'CUSTOMER', paymentTermsDays: 30 },
      });
      if (r.status === 201 || r.status === 200) return { kind: 'customers', id: r.json.id };
      errorLog(`customer CUS-${pad(i)} ${r.status} ${short(r.text, 300)}`);
      return null;
    });
  }
  for (let i = 1; i <= 20; i++) {
    partyTasks.push(async () => {
      const r = await api('POST', '/parties', {
        body: { code: `SUP-${pad(i)}`, nameAr: `مورد ${pad(i)}`, nameEn: `Supplier ${pad(i)}`, partyType: 'SUPPLIER', paymentTermsDays: 30 },
      });
      if (r.status === 201 || r.status === 200) return { kind: 'suppliers', id: r.json.id };
      errorLog(`supplier SUP-${pad(i)} ${r.status} ${short(r.text, 300)}`);
      return null;
    });
  }
  for (const p of (await runPool(partyTasks, 4)).filter(Boolean)) out[p.kind].push(p.id);
  log(`customers: ${out.customers.length}/50, suppliers: ${out.suppliers.length}/20`);

  fs.writeFileSync(path.join(DIR, 'setup.json'), JSON.stringify(out, null, 2));
  log(`wrote setup.json (warehouses=${out.warehouses.length} items=${out.items.length})`);
}

main().catch((e) => {
  errorLog(`masters fatal ${e.stack ?? e}`);
  console.error(e);
  process.exit(1);
});
