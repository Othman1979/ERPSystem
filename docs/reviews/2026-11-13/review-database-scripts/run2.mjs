// Steps 3a-3c: volume generation in one global date order.
// Purchases, sales and journal entries are interleaved by date so that no stock
// document is posted before an earlier-dated one for the same item.
import fs from 'node:fs';
import path from 'node:path';
import { DIR, api, setSession, loadCreds, progress, errorLog, short, sleep } from './lib.mjs';

// ---- configuration (from the request, adjusted for TRIAL plan limits) ----
const N_PURCHASE = 100;
const N_JOURNAL = 250;
const SALES_PER_MONTH = 0; // TRIAL maxInvoicesPerMonth = 50
const LINES_PURCHASE = 40;
const LINES_SALE = 40;
const LINES_JOURNAL = 100;
const CONCURRENCY = 4;
const ERROR_STOP = 20;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30]; // 2026
const LAST_DAY_NOV = 13; // today is 2026-11-13; no future dates
const TOTAL_DAYS = 304 + LAST_DAY_NOV; // 2026-01-01 .. 2026-11-13 inclusive = 317

// ---- deterministic PRNG so the run is reproducible ----
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261113);
const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
function pickDistinct(arr, n) {
  const copy = arr.slice();
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(rng() * copy.length);
    out.push(copy[i]);
    copy[i] = copy[copy.length - 1];
    copy.pop();
  }
  return out;
}

// Money as integer thousandths (fils); avoids float error entirely.
const fmt3 = (n) => `${Math.floor(n / 1000)}.${String(n % 1000).padStart(3, '0')}`;
const dayDate = (d) => new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10);

const log = (m) => {
  console.log(m);
  progress(m);
};

// ---- error budget: stop after > ERROR_STOP errors of the same kind ----
const errorCounts = new Map();
function recordError(kind, status, code, text) {
  const key = `${kind}:${status}:${code ?? '-'}`;
  const n = (errorCounts.get(key) ?? 0) + 1;
  errorCounts.set(key, n);
  errorLog(`${kind} status=${status} code=${code ?? '-'} body=${short(text, 300)}`);
  if (n > ERROR_STOP) throw new Error(`STOP: more than ${ERROR_STOP} errors of kind ${key}`);
}

// ---- stats ----
const stats = {
  purchase: { posted: 0, created: 0, lat: [] },
  sales: { posted: 0, created: 0, lat: [], skippedNoStock: 0, shortLines: 0 },
  journal: { posted: 0, created: 0, lat: [] },
};
const t0 = Date.now();

async function pool(tasks, n) {
  const res = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < tasks.length) {
        const i = next++;
        res[i] = await tasks[i]();
      }
    }),
  );
  return res;
}

async function postDoc(kind, id, postPath, dateLabel) {
  const started = performance.now();
  const r = await api('POST', `${postPath}/${id}/post`, { idem: true });
  const ms = performance.now() - started;
  const ok = r.status === 200 || r.status === 201;
  if (!ok) {
    recordError(`${kind}-post`, r.status, r.json?.error?.code, `id=${id} date=${dateLabel} ${r.text}`);
    return { ok: false, ms };
  }
  stats[kind === 'purchase-post' ? 'purchase' : kind === 'sales-post' ? 'sales' : 'journal'].lat.push(ms);
  return { ok: true, ms };
}

function bump(kind) {
  const s = stats[kind];
  s.posted += 1;
  if (s.posted % 50 === 0) {
    log(`[${new Date().toISOString()}] ${kind} posted=${s.posted} total_elapsed_s=${Math.round((Date.now() - t0) / 1000)}`);
  }
}

async function main() {
  const creds = loadCreds();
  setSession({ accessToken: creds.accessToken, refresh: creds.refreshToken });
  const setup = JSON.parse(fs.readFileSync(path.join(DIR, 'setup.json'), 'utf8'));
  const dump = JSON.parse(fs.readFileSync(path.join(DIR, 'reference-dump.json'), 'utf8'));
  const acct = (code) => {
    const a = dump.accounts.find((x) => x.code === code);
    if (!a) throw new Error(`account ${code} missing`);
    return String(a.id);
  };
  const EXPENSE_IDS = ['5201', '5202', '5203', '5204'].map(acct);
  const CASH_BANK_IDS = ['1101', '1102'].map(acct);
  const WH = String(setup.warehouses[0].id);
  const ITEMS = setup.items.map((i) => String(i.id));
  const CUSTOMERS = setup.customers.map(String);
  const SUPPLIERS = setup.suppliers.map(String);
  // Stock on hand per item in the single warehouse (updated only on successful post).
  const onHand = new Map(ITEMS.map((id) => [id, 0]));

  // ---- schedule: events per day ----
  // Top-up run: purchases on the last day (no backdated stock), journals across the year.
  const purchaseDay = () => TOTAL_DAYS - 1;
  const journalDay = (k) => Math.floor((k * TOTAL_DAYS) / N_JOURNAL);
  const salesByDay = Array.from({ length: TOTAL_DAYS }, () => 0);
  let dayCursor = 0;
  for (let m = 0; m < 11; m++) {
    const len = m === 10 ? LAST_DAY_NOV : MONTH_DAYS[m];
    for (let j = 0; j < SALES_PER_MONTH; j++) {
      salesByDay[dayCursor + Math.floor((j * len) / SALES_PER_MONTH)] += 1;
    }
    dayCursor += MONTH_DAYS[m];
  }
  const purchasesByDay = Array.from({ length: TOTAL_DAYS }, () => []);
  for (let k = 0; k < N_PURCHASE; k++) purchasesByDay[purchaseDay(k)].push(k);
  const journalsByDay = Array.from({ length: TOTAL_DAYS }, () => []);
  for (let k = 0; k < N_JOURNAL; k++) journalsByDay[journalDay(k)].push(k);
  log(`schedule: purchases=${N_PURCHASE} sales=${salesByDay.reduce((a, b) => a + b, 0)} journals=${N_JOURNAL} days=${TOTAL_DAYS} (${dayDate(0)}..${dayDate(TOTAL_DAYS - 1)})`);

  // ---- build + create purchase drafts (no stock dependency) ----
  const purchaseDrafts = new Array(N_PURCHASE);
  const purchaseLines = new Array(N_PURCHASE);
  const purchaseTasks = [];
  for (let k = 0; k < N_PURCHASE; k++) {
    const date = dayDate(purchaseDay(k));
    const items = pickDistinct(ITEMS, LINES_PURCHASE);
    const lines = items.map((itemId) => ({
      itemId,
      qty: String(ri(1, 50)),
      unitCost: fmt3(ri(1000, 20000)),
    }));
    purchaseLines[k] = lines;
    purchaseTasks.push(async () => {
      const r = await api('POST', '/purchase-invoices', {
        body: {
          invoiceDate: date,
          supplierId: SUPPLIERS[k % SUPPLIERS.length],
          warehouseId: WH,
          paymentType: 'CREDIT',
          description: `Review top-up purchase ${k + 1}`,
          lines,
        },
      });
      if (r.status === 201 || r.status === 200) {
        stats.purchase.created += 1;
        purchaseDrafts[k] = String(r.json.id);
      } else {
        recordError('purchase-create', r.status, r.json?.error?.code, r.text);
      }
    });
  }
  await pool(purchaseTasks, CONCURRENCY);
  log(`purchase drafts created: ${stats.purchase.created}/${N_PURCHASE}`);

  // ---- create journal drafts (balanced, 100 lines each, no stock dependency) ----
  const journalDrafts = new Array(N_JOURNAL);
  const journalTasks = [];
  for (let k = 0; k < N_JOURNAL; k++) {
    const date = dayDate(journalDay(k));
    // 50 expense debits, 50 cash/bank credits that sum to the same total.
    const debitAmts = Array.from({ length: LINES_JOURNAL / 2 }, () => ri(1000, 200000));
    const total = debitAmts.reduce((a, b) => a + b, 0);
    const base = Math.floor(total / (LINES_JOURNAL / 2));
    let rem = total - base * (LINES_JOURNAL / 2);
    const creditAmts = Array.from({ length: LINES_JOURNAL / 2 }, (_, i) => {
      const extra = i < rem ? 1 : 0;
      return base + extra;
    });
    const lines = [];
    for (let i = 0; i < LINES_JOURNAL / 2; i++) {
      lines.push({ accountId: EXPENSE_IDS[i % EXPENSE_IDS.length], debit: fmt3(debitAmts[i]), description: `Expense ${i + 1}` });
    }
    for (let i = 0; i < LINES_JOURNAL / 2; i++) {
      lines.push({ accountId: CASH_BANK_IDS[i % CASH_BANK_IDS.length], credit: fmt3(creditAmts[i]), description: `Payment ${i + 1}` });
    }
    journalTasks.push(async () => {
      const r = await api('POST', '/journal-entries', {
        body: { entryDate: date, description: `Review top-up journal ${k + 1}`, lines },
      });
      if (r.status === 201 || r.status === 200) {
        stats.journal.created += 1;
        journalDrafts[k] = String(r.json.id);
      } else {
        recordError('journal-create', r.status, r.json?.error?.code, r.text);
      }
    });
  }
  await pool(journalTasks, CONCURRENCY);
  log(`journal drafts created: ${stats.journal.created}/${N_JOURNAL}`);

  // ---- chronological posting loop ----
  for (let d = 0; d < TOTAL_DAYS; d++) {
    const date = dayDate(d);

    // a) purchases of the day (posted, then stock on hand updated)
    for (const k of purchasesByDay[d]) {
      if (!purchaseDrafts[k]) continue;
      const { ok } = await postDoc('purchase-post', purchaseDrafts[k], '/purchase-invoices', date);
      if (ok) {
        for (const l of purchaseLines[k]) onHand.set(l.itemId, onHand.get(l.itemId) + Number(l.qty));
        bump('purchase');
      }
    }

    // b) sales of the day: build lines against on-hand stock (reserved at build time)
    const saleCount = salesByDay[d];
    if (saleCount > 0) {
      const saleSpecs = [];
      for (let s = 0; s < saleCount; s++) {
        const eligible = ITEMS.filter((id) => onHand.get(id) > 0);
        const picks = pickDistinct(eligible, LINES_SALE);
        if (picks.length === 0) {
          stats.sales.skippedNoStock += 1;
          continue;
        }
        if (picks.length < LINES_SALE) stats.sales.shortLines += 1;
        const lines = picks.map((itemId) => {
          const qty = Math.min(ri(1, 3), onHand.get(itemId));
          onHand.set(itemId, onHand.get(itemId) - qty); // reserve
          return { itemId, qty: String(qty), unitPrice: fmt3(ri(5000, 30000)) };
        });
        saleSpecs.push({ lines, reserved: lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })) });
      }
      const draftTasks = saleSpecs.map((spec) => async () => {
        const r = await api('POST', '/sales-invoices', {
          body: {
            invoiceDate: date,
            customerId: CUSTOMERS[(d + stats.sales.created) % CUSTOMERS.length],
            warehouseId: WH,
            paymentType: 'CREDIT',
            description: 'Review sale',
            lines: spec.lines,
          },
        });
        if (r.status === 201 || r.status === 200) {
          stats.sales.created += 1;
          spec.id = String(r.json.id);
        } else {
          recordError('sales-create', r.status, r.json?.error?.code, r.text);
        }
      });
      await pool(draftTasks, CONCURRENCY);
      for (const spec of saleSpecs) {
        if (!spec.id) {
          for (const r of spec.reserved) onHand.set(r.itemId, onHand.get(r.itemId) + r.qty); // release
          continue;
        }
        const { ok } = await postDoc('sales-post', spec.id, '/sales-invoices', date);
        if (ok) bump('sales');
        else for (const r of spec.reserved) onHand.set(r.itemId, onHand.get(r.itemId) + r.qty); // release
      }
    }

    // c) journal entries of the day
    for (const k of journalsByDay[d]) {
      if (!journalDrafts[k]) continue;
      const { ok } = await postDoc('journal-post', journalDrafts[k], '/journal-entries', date);
      if (ok) bump('journal');
    }
  }

  // ---- summary ----
  const p95 = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]);
  };
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const summary = {
    tenantId: '1',
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    schedule: { purchases: N_PURCHASE, sales: saleCountTotal(salesByDay), journals: N_JOURNAL, firstDay: dayDate(0), lastDay: dayDate(TOTAL_DAYS - 1) },
    purchase: { created: stats.purchase.created, posted: stats.purchase.posted, avgMs: avg(stats.purchase.lat), p95Ms: p95(stats.purchase.lat), first50AvgMs: avg(stats.purchase.lat.slice(0, 50)), last50AvgMs: avg(stats.purchase.lat.slice(-50)) },
    sales: { created: stats.sales.created, posted: stats.sales.posted, avgMs: avg(stats.sales.lat), p95Ms: p95(stats.sales.lat), first50AvgMs: avg(stats.sales.lat.slice(0, 50)), last50AvgMs: avg(stats.sales.lat.slice(-50)), skippedNoStock: stats.sales.skippedNoStock, shortLines: stats.sales.shortLines },
    journal: { created: stats.journal.created, posted: stats.journal.posted, avgMs: avg(stats.journal.lat), p95Ms: p95(stats.journal.lat) },
    errorKinds: Object.fromEntries(errorCounts),
  };
  fs.writeFileSync(path.join(DIR, 'summary2.json'), JSON.stringify(summary, null, 2));
  log(`SUMMARY ${JSON.stringify(summary)}`);
}

function saleCountTotal(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

main().catch((e) => {
  errorLog(`run fatal ${e.stack ?? e}`);
  progress(`RUN ABORTED: ${e.message}`);
  console.error(e);
  process.exit(1);
});
