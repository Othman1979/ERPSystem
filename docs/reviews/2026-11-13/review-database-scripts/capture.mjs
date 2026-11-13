// Runs the app's hot Prisma queries for one tenant, captures the SQL Prisma emits,
// then EXPLAINs each one and times it. Read-only.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('D:/ERPSYSTEM/.claude/worktrees/fix-database-d7fc95/apps/api/package.json');
const { PrismaMariaDb } = await import('file:///D:/ERPSYSTEM/.claude/worktrees/fix-database-d7fc95/apps/api/node_modules/@prisma/adapter-mariadb/dist/index.mjs');
const { PrismaClient } = await import(process.env.CLIENT ?? 'file:///D:/ERPSYSTEM/.claude/worktrees/fix-database-d7fc95/apps/api/dist/generated/prisma/client.js');
const mariadb = require('mariadb');
const env = fs.readFileSync('D:/ERPSYSTEM/.claude/worktrees/fix-database-d7fc95/apps/api/.env','utf8');
const u = new URL(env.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)[1]);
const cfg = {host:u.hostname,port:+u.port||3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:process.env.DB ?? u.pathname.slice(1),connectionLimit:2};
const pool = mariadb.createPool(cfg);
const db = new PrismaClient({ adapter: new PrismaMariaDb(pool), log: [{ emit: 'event', level: 'query' }] });
let captured = [];
db.$on('query', (e) => captured.push({ sql: e.query, params: JSON.parse(e.params) }));
const T = BigInt(process.argv[2]);
const company = await db.company.findFirst({ where: { tenantId: T } });
const C = company.id;
const acc = await db.journalLine.groupBy({ by: ['accountId'], where: { tenantId: T }, _count: true, orderBy: { _count: { accountId: 'desc' } }, take: 1 });
const A = acc[0]?.accountId;
const item = await db.stockMovement.groupBy({ by: ['itemId'], where: { tenantId: T }, _count: true, orderBy: { _count: { itemId: 'desc' } }, take: 1 });
const I = item[0]?.itemId;
const cust = await db.salesInvoice.findFirst({ where: { tenantId: T }, select: { customerId: true } });
const from = new Date('2026-03-01'), to = new Date('2026-06-30');
const Q = {
  trial_balance: () => db.journalLine.groupBy({ by: ['accountId'], where: { tenantId: T, entry: { tenantId: T, companyId: C, status: 'POSTED', entryDate: { gte: from, lte: to } } }, _sum: { debit: true, credit: true } }),
  gl_rows: () => db.journalLine.findMany({ where: { tenantId: T, accountId: A, entry: { tenantId: T, companyId: C, status: 'POSTED', isOpening: false, entryDate: { gte: from, lte: to } } }, include: { entry: { select: { entryNo: true, entryDate: true, description: true } } }, orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { id: 'asc' } }, { lineNo: 'asc' }] }),
  gl_opening: () => db.journalLine.aggregate({ where: { tenantId: T, accountId: A, entry: { tenantId: T, companyId: C, status: 'POSTED', OR: [{ entryDate: { lt: from } }, { isOpening: true, entryDate: { gte: from, lte: to } }] } }, _sum: { debit: true, credit: true } }),
  party_statement: () => db.journalLine.findMany({ where: { tenantId: T, partyType: 'CUSTOMER', partyId: cust.customerId, entry: { tenantId: T, companyId: C, status: 'POSTED', entryDate: { gte: from, lte: to } } }, orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { id: 'asc' } }, { lineNo: 'asc' }] }),
  invoice_list: () => db.salesInvoice.findMany({ where: { tenantId: T, companyId: C }, orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }], take: 300 }),
  quota_count: () => db.salesInvoice.count({ where: { tenantId: T, companyId: C, status: 'POSTED', invoiceDate: { gte: new Date('2026-05-01'), lt: new Date('2026-06-01') } } }),
  aging_invoices: () => db.salesInvoice.findMany({ where: { tenantId: T, companyId: C, status: 'POSTED', paymentType: 'CREDIT', invoiceDate: { lte: to } }, orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }], select: { id: true, customerId: true, invoiceDate: true, dueDate: true, grandTotal: true } }),
  oldest_first_customer: () => db.salesInvoice.findMany({ where: { tenantId: T, companyId: C, status: 'POSTED', paymentType: 'CREDIT', customerId: cust.customerId }, orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }], select: { id: true } }),
  movements_list: () => db.stockMovement.findMany({ where: { tenantId: T }, orderBy: [{ movementDate: 'desc' }, { id: 'desc' }], skip: 5000, take: 50 }),
  movements_count: () => db.stockMovement.count({ where: { tenantId: T } }),
  item_card: () => db.stockMovement.findMany({ where: { tenantId: T, itemId: I, movementDate: { gte: from, lte: to } }, orderBy: [{ movementDate: 'asc' }, { id: 'asc' }] }),
  items_balance: () => db.stockMovement.groupBy({ by: ['itemId', 'movementType'], where: { tenantId: T, movementDate: { gte: from, lte: to } }, _sum: { qtyIn: true, qtyOut: true, totalCost: true } }),
  verify_scan: () => db.stockMovement.findMany({ where: { tenantId: T }, orderBy: [{ movementDate: 'asc' }, { id: 'asc' }], select: { warehouseId: true, itemId: true, qtyIn: true, qtyOut: true } }),
  journal_list: () => db.journalEntry.findMany({ where: { tenantId: T, companyId: C }, orderBy: [{ entryDate: 'desc' }, { id: 'desc' }], take: 200, include: { _count: { select: { lines: true } } } }),
  purchase_list: () => db.purchaseInvoice.findMany({ where: { tenantId: T, companyId: C }, orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }], take: 300 }),
  purchase_list_posted: () => db.purchaseInvoice.findMany({ where: { tenantId: T, companyId: C, status: 'POSTED' }, orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }], take: 300 }),
  sales_summary: () => db.salesInvoice.groupBy({ by: ['customerId'], where: { tenantId: T, companyId: C, status: 'POSTED', invoiceDate: { gte: from, lte: to } }, _sum: { grandTotal: true } }),
  party_posted_count: () => db.salesInvoice.count({ where: { tenantId: T, customerId: cust.customerId, status: 'POSTED' } }),
  journal_list_posted: () => db.journalEntry.findMany({ where: { tenantId: T, companyId: C, status: 'POSTED' }, orderBy: [{ entryDate: 'desc' }, { id: 'desc' }], take: 200 }),
  balances_by_item: () => db.stockBalance.findMany({ where: { tenantId: T, itemId: I, qtyOnHand: { not: 0 } } }),
  control_by_party: () => db.journalLine.groupBy({ by: ['partyId'], where: { tenantId: T, partyType: 'CUSTOMER', partyId: { not: null }, account: { tenantId: T, controlType: { not: null } }, entry: { tenantId: T, companyId: C, status: 'POSTED', entryDate: { lte: to } } }, _sum: { debit: true, credit: true } }),
};
const out = [];
for (const [name, fn] of Object.entries(Q)) {
  // Warm once, then the median of 5 runs; SQL from the last run.
  await fn(); const times = []; let r;
  for (let k = 0; k < 5; k++) { captured = []; const t0 = performance.now(); r = await fn(); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b); const ms = times[2];
  const rows = Array.isArray(r) ? r.length : (typeof r === 'number' ? r : 1);
  out.push({ name, ms: Math.round(ms), rows, sql: captured.map((c) => c) });
}
const conn = await pool.getConnection();
let md = ''; const json = [];
for (const o of out) { const jo = { name: o.name, ms: o.ms, rows: o.rows, stmts: [] }; json.push(jo);
  md += `\n### ${o.name}  (${o.ms} ms, ${o.rows} rows)\n`;
  for (const c of o.sql) {
    md += '```sql\n' + c.sql + '\n-- params ' + JSON.stringify(c.params) + '\n```\n';
    if (/^\s*select/i.test(c.sql)) {
      try { const ex = await conn.query({ sql: 'EXPLAIN ' + c.sql, bigIntAsNumber: true }, c.params.map((p) => (typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : p)));
        jo.stmts.push({ sql: c.sql.slice(0, 160), explain: ex.map((e) => ({ table: e.table, type: e.type, key: e.key, rows: e.rows, extra: e.Extra ?? '' })) }); md += '| table | type | key | rows | Extra |\n|---|---|---|---|---|\n' + ex.map((e) => `| ${e.table} | ${e.type} | ${e.key} | ${e.rows} | ${e.Extra ?? ''} |`).join('\n') + '\n';
      } catch (e) { md += 'EXPLAIN failed: ' + e.message + '\n'; }
    }
  }
}
conn.release();
fs.writeFileSync(process.argv[3], md); fs.writeFileSync(process.argv[3] + '.json', JSON.stringify(json, null, 1));
console.log(out.map((o) => `${o.name}\t${o.ms}ms\t${o.rows}`).join('\n'));
await db.$disconnect(); await pool.end();
