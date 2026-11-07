import 'dotenv/config';
import mariadb from 'mariadb';
async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  const conn = await mariadb.createConnection({
    host: url.hostname, port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  });
  await conn.query('CREATE DATABASE IF NOT EXISTS erp_test');
  console.log('erp_test ready');
  await conn.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
