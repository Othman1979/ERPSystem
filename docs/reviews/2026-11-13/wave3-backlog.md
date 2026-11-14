# Backlog from the 2026-11-13 reviews: status

Every item from the 2026-11-13 reviews has been fixed and merged (waves 1–3, PRs #21–#36), except the one deferred item at the end. The follow-ups that #35 and #36 left are in wave 4 (PRs 4A and 4B).

## Deferred or partly fixed after wave 2: all done

| ID | Fixed in |
|---|---|
| TRADE-11 (read side), TRADE-14, PLAT-13, LEDGER-19 (keyset) | #35 (ADR-022, ADR-003 update) |
| TRADE-16 | #30 (`isConflictRetry` mapped to 409) |
| TRADE-21 | #33 (batched cost) and #31 (PDF speed) |
| PLAT-15 | #36 (ADR-023) |
| WEB-05, WEB-13 | #32 |
| DB-08, DB-14, DB-15 | #33 (ADR-021) |

## Follow-ups found during wave 2: all done, except one

| Item | Fixed in |
|---|---|
| Users page hidden from accountants (permissions in `/me`) | #32 |
| Flaky e-invoice test | #34 |
| Account-lock test (LEDGER-03), and a MariaDB 10.11 deadlock it found | #34 |
| Phone user menu checked at 375 px | #32 |
| Email verification for invitations | **Deferred:** it needs the app to send email. The acceptance code (ADR-012) covers PLAT-10 until then. |

## Follow-ups from #35 and #36: wave 4A

- Cash box and bank account updates are validated; cash boxes can be given a branch.
- Clearing a branch field works.
- Service-only purchase invoices can be returned with no warehouse (owner decision, 2026-11-14).
- An allocation reduces the invoice's branch's aging, whatever branch the voucher is on (owner decision, 2026-11-14).
- `GET /journal-entries` speed.
- The e2e database name can be configured.
- Purchase invoice edit keeps the supplier invoice number and date.
- Invoice edit loads the cash account.
- The opening balances screen is paged.
- The Items screen loads stock for the visible page only.

PR #9 (journal party picker) is brought up to date in wave 4B.

## Deployment notes

- **Maintenance window:** the #29 and #35 migrations rebuild or backfill large tables (`stock_movements`, `journal_lines`, `einvoice_submissions`), so run them in a maintenance window (`docs/runbooks/deploy.md`).
- **Stop the API first:** #28 drops `reversal_of_id` columns, so stop the API before `migrate deploy`.
- **After deploying:** run `job:preflight`, `job:integrity-check`, `job:stock-verify` and `ledger:check`.
