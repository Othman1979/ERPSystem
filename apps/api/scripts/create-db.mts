/**
 * Creates the database named in DATABASE_URL when it is missing
 * (scripts/start-local.ps1). Prints "database <name> created" or "database <name> exists".
 * Run: pnpm --filter api db:create
 */
import 'dotenv/config';
import mariadb from 'mariadb';

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unexpected database name in DATABASE_URL: "${name}"`);
  }
  const conn = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  try {
    const rows = await conn.query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
    if (rows.length > 0) {
      console.log(`database ${name} exists`);
      return;
    }
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`database ${name} created`);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
