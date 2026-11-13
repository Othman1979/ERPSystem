// Builds <target> with main's migrations only (exact production path, implicit
// FK indexes included), then copies every table's rows from <source>.
// usage: node rebuild.mjs <source> <target>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const API = 'D:/ERPSYSTEM/.claude/worktrees/fix-database-d7fc95/apps/api';
const require = createRequire(`${API}/package.json`);
const mariadb = require('mariadb');
const env = fs.readFileSync(`${API}/.env`, 'utf8');
const u = new URL(env.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)[1]);
const [source, target] = process.argv.slice(2);
const conn = await mariadb.createConnection({ host: u.hostname, port: +u.port || 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), multipleStatements: true });

await conn.query(`DROP DATABASE IF EXISTS \`${target}\``);
await conn.query(`CREATE DATABASE \`${target}\``); // server default collation, like a hosting panel
await conn.query(`USE \`${target}\``);
const dir = `${API}/prisma/migrations`;
const migrations = fs.readdirSync(dir).filter((d) => /^\d{14}_/.test(d) && d !== '20261113164500_db_review_indexes').sort();
await conn.query('CREATE TABLE `_prisma_migrations` (`id` VARCHAR(36) PRIMARY KEY, `checksum` VARCHAR(64) NOT NULL, `finished_at` DATETIME(3), `migration_name` VARCHAR(255) NOT NULL, `logs` TEXT, `rolled_back_at` DATETIME(3), `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `applied_steps_count` INT UNSIGNED NOT NULL DEFAULT 0)');
const { createHash, randomUUID } = await import('node:crypto');
for (const m of migrations) {
  const sql = fs.readFileSync(path.join(dir, m, 'migration.sql'), 'utf8');
  await conn.query(sql);
  await conn.query('INSERT INTO `_prisma_migrations` (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, NOW(3), ?, 1)', [randomUUID(), createHash('sha256').update(sql).digest('hex'), m]);
}
console.log('migrations applied:', migrations.length);

await conn.query('SET FOREIGN_KEY_CHECKS = 0');
const tables = (await conn.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`, [target])).map((r) => r.t);
let rows = 0;
for (const t of tables) {
  const cols = (await conn.query(
    `SELECT a.column_name AS c FROM information_schema.columns a JOIN information_schema.columns b ON b.table_schema = ? AND b.table_name = a.table_name AND b.column_name = a.column_name WHERE a.table_schema = ? AND a.table_name = ? ORDER BY a.ordinal_position`,
    [source, target, t],
  )).map((r) => `\`${r.c}\``);
  const r = await conn.query(`INSERT INTO \`${target}\`.\`${t}\` (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM \`${source}\`.\`${t}\``);
  rows += Number(r.affectedRows);
}
await conn.query('SET FOREIGN_KEY_CHECKS = 1');
console.log('tables:', tables.length, 'rows copied:', rows);
await conn.end();
