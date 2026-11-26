import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` (Prisma 7 reads it here, not from package.json): plans,
    // currencies, roles. A fresh database needs it before the first sign-up.
    // Through node, not the `tsx` binary: works whether or not node_modules/.bin is on the PATH.
    seed: 'node --import tsx prisma/seed.ts',
  },
  // `prisma generate` (postinstall) needs no database: without DATABASE_URL the
  // datasource is left out, so a fresh checkout installs before apps/api/.env
  // exists. Commands that do need it (migrate, db seed) then stop and say so.
  // env() throws when the variable is unset, hence the guard.
  ...(process.env.DATABASE_URL ? { datasource: { url: env('DATABASE_URL') } } : {}),
});
