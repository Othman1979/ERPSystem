import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import mariadb from 'mariadb';
import { PrismaClient } from '../src/generated/prisma/client.js';

async function main(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const pool = mariadb.createPool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectionLimit: 2,
  });
  const p = new PrismaClient({ adapter: new PrismaMariaDb(pool) });
  const u = await p.user.update({
    where: { email: 'owner@test.com' },
    data: { isPlatformAdmin: true },
  });
  console.log('admin set:', u.email, u.isPlatformAdmin);
  await p.$disconnect();
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
