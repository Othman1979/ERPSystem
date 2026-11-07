/**
 * Phase 1 seed: plans, currencies, system roles + role permissions.
 * Idempotent — safe to run repeatedly (upserts by unique code).
 * Run: pnpm --filter api seed
 */
import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import mariadb from 'mariadb';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { ROLE_DEFINITIONS, ROLE_PERMISSIONS } from '../src/common/permissions/permissions.js';

const url = new URL(process.env.DATABASE_URL!);
const pool = mariadb.createPool({
  host: url.hostname,
  port: url.port ? Number(url.port) : 3306,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  connectionLimit: 5,
});
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(pool) });

const PLANS = [
  {
    code: 'TRIAL',
    nameAr: 'تجريبي',
    nameEn: 'Trial',
    maxUsers: 3,
    maxBranches: 1,
    maxWarehouses: 1,
    maxInvoicesPerMonth: 50,
    priceMonthly: null,
    priceYearly: null,
  },
  {
    code: 'BASIC',
    nameAr: 'أساسي',
    nameEn: 'Basic',
    maxUsers: 5,
    maxBranches: 2,
    maxWarehouses: 2,
    maxInvoicesPerMonth: 300,
    priceMonthly: '15.000',
    priceYearly: '150.000',
  },
  {
    code: 'PRO',
    nameAr: 'احترافي',
    nameEn: 'Pro',
    maxUsers: 20,
    maxBranches: 10,
    maxWarehouses: 10,
    maxInvoicesPerMonth: 5000,
    priceMonthly: '40.000',
    priceYearly: '400.000',
  },
];

const CURRENCIES = [
  { code: 'JOD', nameAr: 'دينار أردني', nameEn: 'Jordanian Dinar', symbol: 'د.أ', decimalPlaces: 3 },
  { code: 'USD', nameAr: 'دولار أمريكي', nameEn: 'US Dollar', symbol: '$', decimalPlaces: 2 },
  { code: 'EUR', nameAr: 'يورو', nameEn: 'Euro', symbol: '€', decimalPlaces: 2 },
];

async function main(): Promise<void> {
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: { ...plan, priceMonthly: plan.priceMonthly, priceYearly: plan.priceYearly },
      create: plan,
    });
  }

  for (const c of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: c.code },
      update: c,
      create: c,
    });
  }

  for (const role of ROLE_DEFINITIONS) {
    const record = await prisma.role.upsert({
      where: { code: role.code },
      update: { nameAr: role.nameAr, nameEn: role.nameEn, description: role.description },
      create: role,
    });
    const codes = ROLE_PERMISSIONS[role.code] ?? [];
    await prisma.rolePermission.deleteMany({ where: { roleId: record.id } });
    await prisma.rolePermission.createMany({
      data: codes.map((permissionCode) => ({ roleId: record.id, permissionCode })),
      skipDuplicates: true,
    });
    console.log(`role ${role.code}: ${codes.length} permissions`);
  }

  console.log('seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
