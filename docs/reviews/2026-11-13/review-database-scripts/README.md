# Volume test and EXPLAIN (review-database §5, rerun by wave 2 session 2D)

The scripts the review prepared, as they were run on 2026-11-13 for the index plan (DB-10). The results are in
`explain-before-after.md`.

## What was run
1. **Database:** a scratch database `erp_dev_2d` on the local MariaDB 10.4.32 (XAMPP), `innodb_buffer_pool_size` = 16 MB.
   It was created `utf8mb4_unicode_ci`, migrated to `main` and seeded.
2. **API:** the built API of `main` on port 3671 against it.
3. **Data:** one TRIAL tenant, through the API.
   - `setup.mjs`: registration.
   - `masters.mjs`: fiscal years 2025 and 2026, 1 warehouse (the TRIAL limit), 200 stock items, 50 customers and 20
     suppliers.
   - `run.mjs`, posted in date order from 2026-01-01 to 2026-11-13:
     - 600 credit purchase invoices of 40 lines;
     - 550 credit sales invoices of 40 lines (the TRIAL limit, 50 a month);
     - 250 manual journal entries of 100 lines.
   - `run2.mjs` (after `login.mjs`) is a top-up to 50k: 100 purchases dated on the last day (no backdated stock), and
     250 more journal entries.
   - Result: 50,000 stock movements and 54,850 journal lines.
4. **Synthetic drafts:** `inflate.mjs` added DRAFT copies of the posted headers: ×30 invoices and ×10 entries. The
   reason is in `explain-before-after.md`.
5. **Rebuild:** `rebuild.mjs <source> <target>` built a fresh database with `main`'s migrations only, then copied every
   row into it. So "before" is exactly `main`'s schema, implicit FK indexes included.
6. **Before:** `capture.mjs <tenantId> before.md` ran each hot query through the Prisma client of `main`.
   - It captures the SQL Prisma sends, runs EXPLAIN on it, and times it as the median of 5 runs after one warm-up.
   - `ANALYZE TABLE` ran on the hot tables first.
7. **After:** `prisma migrate deploy` applied `20261113164500_db_review_indexes` to the same database. Then
   `ANALYZE TABLE` and the same capture with the new client.
8. **Table:** `compare.mjs before.md.json after.md.json out.md` builds it.
9. **Cleanup:** the scratch databases were dropped at the end.

## Paths
The scripts carry the paths and ports of that run:
- `lib.mjs`: the API base URL.
- `capture.mjs`: the API folder, its `.env`, and the generated client (`CLIENT=` overrides it, `DB=` the database).

Change them for another run.

`creds.json`, `setup.json` and `reference-dump.json` hold a password and tokens. They are written next to the scripts
and are not committed.

`orphans.sql` holds the review's one-off integrity counts. The permanent version is the
`integrity-check` job (ADR-019 §5).
