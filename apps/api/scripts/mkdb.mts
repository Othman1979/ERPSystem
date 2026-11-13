import 'dotenv/config';
import mariadb from 'mariadb';
async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  const conn = await mariadb.createConnection({
    host: url.hostname, port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  });
  // The tables' collation (ADR-019, DB-18); migration 20261113164500 also sets it.
  await conn.query('CREATE DATABASE IF NOT EXISTS erp_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  console.log('erp_test ready');
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
