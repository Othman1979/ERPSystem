// Adds synthetic DRAFT copies of document headers (no lines) so the list and
// date indexes are measured at a realistic size. Lines, movements and journal
// lines stay the real postings. usage: DB=erp_dev_2d node inflate.mjs <tenantId>
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('D:/ERPSYSTEM/.claude/worktrees/fix-database-d7fc95/apps/api/package.json');
const mariadb = require('mariadb');
const env = fs.readFileSync('D:/ERPSYSTEM/.claude/worktrees/fix-database-d7fc95/apps/api/.env', 'utf8');
const u = new URL(env.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)[1]);
const db = process.env.DB;
const conn = await mariadb.createConnection({ host: u.hostname, port: +u.port || 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: db });
const T = Number(process.argv[2]);

// table -> [copies per posted row, columns forced in the copy]
const PLAN = {
  sales_invoices: [30, { status: "'DRAFT'", invoice_no: 'NULL', journal_entry_id: 'NULL', posted_at: 'NULL', posted_by: 'NULL' }],
  purchase_invoices: [30, { status: "'DRAFT'", invoice_no: 'NULL', journal_entry_id: 'NULL', posted_at: 'NULL', posted_by: 'NULL' }],
  journal_entries: [10, { status: "'DRAFT'", entry_no: 'NULL', source_type: 'NULL', source_id: 'NULL', reversal_of_id: 'NULL', posted_at: 'NULL', posted_by: 'NULL' }],
};
const nums = Array.from({ length: 30 }, (_, i) => `SELECT ${i + 1} n`).join(' UNION ALL ');
for (const [table, [copies, forced]] of Object.entries(PLAN)) {
  const cols = (await conn.query(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`, [table])).map((r) => r.c).filter((c) => c !== 'id');
  const select = cols.map((c) => (c in forced ? forced[c] : `t.\`${c}\``)).join(', ');
  const sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) SELECT ${select} FROM \`${table}\` t JOIN (${nums}) k ON k.n <= ${copies} WHERE t.tenant_id = ? AND t.status = 'POSTED'`;
  const r = await conn.query(sql, [T]);
  console.log(table, 'inserted', Number(r.affectedRows));
}
await conn.end();
