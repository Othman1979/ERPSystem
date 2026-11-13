import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` (Prisma 7 reads it here, not from package.json): plans,
    // currencies, countries, roles. A fresh database needs it before the first sign-up.
    // Through node, not the `tsx` binary: works whether or not node_modules/.bin is on the PATH.
    seed: 'node --import tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
