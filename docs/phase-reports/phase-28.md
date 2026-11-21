# Phase 28 — Payroll completion

**Reference:** [ADR-043](../decisions/ADR-043-phase28-payroll-completion.md).
**Scope of this delivery:** 28A automatic Jordanian income-tax withholding and 28B leave balances, requests, payroll effects, and provisions. End of service (28C) is not included.

## PY5 — salary, bonus, and absence

Settings: single employee, no dependants, JOD 9,000.000 annual personal exemption, and the default monthly brackets.

| Input | Amount |
|---|---:|
| Basic pay | 2,000.000 |
| Tax-subject bonus movement | 500.000 |
| Tax-subject one-day absence | (66.667) |
| **Taxable income** | **2,433.333** |
| Monthly personal exemption | (750.000) |
| **Excess** | **1,683.333** |
| Progressive bracket tax | 212.833 |
| National contribution | 0.000 |
| **Income tax withheld** | **212.833** |

The excess falls into the 25% bracket after the first four JOD 416.000 bands: `416 × 5% + 416 × 10% + 416 × 15% + 416 × 20% + 19.333 × 25% = 212.833` after final three-place rounding.

## PY6 — dependant exemption and fixed allowance

Basic pay JOD 1,200.000 plus tax-subject fixed transport allowance JOD 50.000 gives taxable income of JOD 1,250.000. Personal and dependant exemptions total JOD 18,000.000 annually, or JOD 1,500.000 monthly. Excess and income tax are both JOD 0.000.

## PY7 — high monthly income

Basic pay is JOD 20,000.000; the employee is not SSC-covered. Taxable income is JOD 20,000.000. After the JOD 750.000 monthly personal exemption, excess is JOD 19,250.000.

- Bracket tax: `416 × 5% + 416 × 10% + 416 × 15% + 416 × 20% + 17,586 × 25% = 4,604.500`.
- National contribution: `(19,250 − 16,666) × 1% = 25.840`.
- **Income tax:** `round3(4,604.500 + 25.840) = 4,630.340`; national contribution is stored separately as JOD 25.840.

## PY7b — other annual exemption

With an additional annual exemption of JOD 2,000.000, the monthly exemption is `round3((9,000 + 2,000) / 12) = 916.667`, and excess is JOD 19,083.333. Bracket tax is JOD 4,562.833; national contribution is `round3((19,083.333 − 16,666) × 1%) = 24.173`. **Income tax is JOD 4,587.007** after rounding the sum of the unrounded components.

## Acceptance coverage

- [x] Calculator tests cover PY5–PY7 and employees not subject to income tax.
- [x] MariaDB payroll run covers PY5–PY7, manual override and reset, tenant isolation, and the full credit to `PAYROLL_TAX_PAYABLE`.
- [x] Existing PY1–PY4 expected amounts remain unchanged.

## Implementation and verification

The 28A migration is `apps/api/prisma/migrations/20261121133409_phase28a_income_tax/migration.sql`, created with `prisma migrate dev` against the isolated `erp_phase28a_test` database. After checking the new database had no tenant or company data, it was recreated before the finalized migration was reapplied. No preview database or pre-existing migration was changed.

- Payroll calculator and chart-template specs: **2 suites, 19 tests passed**.
- Payroll MariaDB E2E: **12 tests passed**, including the existing PY1–PY4 and the new PY5–PY7 flow.
- Web tests: **104 files, 894 tests passed**.
- API build, root typecheck, root lint, and API typecheck/lint after the final E2E test adjustment passed.
- Prisma client generation, OpenAPI Prisma-model generation, and API-client generation passed.
- The initial full `pnpm test` exposed two pre-existing issues: the OpenAPI contract omitted the documented document-lock 204 route, and purge-expired targeted stale `erp_test` without `document_edit_locks`. Follow-up added the route to the contract allowlist, deployed pending migrations to `erp_test` only, and both focused tests passed. The final full-suite result for 28B is recorded below.

No PY1–PY4 fixtures required tax changes. Visual verification was not performed.

## 28B — Leave balances, requests, payroll effect, and provision

Annual and sick leave requests are confined to one calendar year because their limits are per year. Other leave categories may cross 31/12 as one request, subject to the per-request limit.

### LV1 — first-year entitlement, carry, and lapse

Hired 01/07/2026: 184 service days × 14 ÷ 365 = **7.06** days earned in 2026. With no 2026 leave taken, 7.06 days carry into 2027. After 2 days are taken in 2026, 5.06 carry plus 14.00 earned in 2027 gives **19.06** available in 2027. With no carry consumed by the 3 days taken in 2027, 14.00 unused 2027 days carry into 2028; plus 14.00 earned in 2028 gives **28.00** available.

### LV1b — senior-rate anniversary

Hired 01/04/2021: 90 days in 2026 before the fifth anniversary earn at 14 days/year; the remaining 275 service days earn at 21 days/year. `(90 × 14 + 275 × 21) ÷ 365 = 19.27` days for 2026. The full 2027 entitlement is **21.00** days.

### LV2 — working-day calendar

With Friday (`5`) as the weekly rest day and 08/12/2026 as a company holiday, 06/12/2026–12/12/2026 spans **7 calendar days** and excludes Friday and the holiday, leaving **5.00 leave days**.

### LV3 — unpaid leave and SSC

Basic JOD 600.000, SSC-covered, with 3 unpaid days: daily wage `600 ÷ 30 = 20.000`; deduction **60.000**; SSC base **540.000**; employee SSC **40.500**; employer SSC **76.950**; income tax **0.000**; net pay **499.500**.

### LV4 — maternity across payroll periods

Basic JOD 900.000; maternity leave 15/11/2026–23/01/2027 is **70 calendar days**. For an SSC-covered employee:

| Period | Leave deduction | SSC base | Employee SSC | Employer SSC | Net |
|---|---:|---:|---:|---:|---:|
| November 2026 | 480.000 | 420.000 | 31.500 | 59.850 | 388.500 |
| December 2026 | 900.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| January 2027 | 690.000 | 290.000 | 21.750 | 41.325 | 188.250 |

The January SSC base uses the minimum-wage floor because the base remains positive. A non-SSC-covered employee receives no maternity deduction.

### LV5 — accrued annual-leave provision and reversal

Basic JOD 600.000 plus fixed transport JOD 40.000 gives daily wage `round6(640 ÷ 30) = 21.333333`. Hired 01/07/2026 with no leave taken, 2026 accrued leave is 7.06 days; the December provision is **150.613**. The 2027 carry plus January accrual is 8.25 days; the January provision is **176.000**, a **25.387** delta. Posting debits 5207 and credits 2109; reversing the January payroll run reverses its 25.387 entry.

### 28B implementation and verification

The schema and existing-company defaults are in `apps/api/prisma/migrations/20261121141806_phase28b_leave/migration.sql`. The migration adds payroll leave settings, company-scoped holiday/type/request/adjustment tables, payroll-line request/provision fields, composite tenant/company relations, and the provision journal link. Existing companies are backfilled by migration SQL using `INSERT ... SELECT` for accounts 2109/5207, their payroll mappings, the unpaid/maternity deduction elements, six leave types, and `LEAVE_REQUEST` document sequences. New companies receive the same defaults through `ChartProvisioningService`.

Leave approval, adjustment, and cancellation are company-scoped and audited; the payroll flow deducts approved unpaid/maternity leave, applies the SSC minimum only to a positive pre-floor base, and posts/reverses the annual provision delta in the run transaction. Annual and sick requests alone are year-bounded; other categories may span years as one request.

- Leave and payroll calculator, plus chart-template specs: **3 suites, 26 tests passed**.
- Payroll MariaDB E2E: **15/15 passed**, including PY1–PY7, LV1–LV5, every leave endpoint's tenant/company isolation, cancellation after posting, and provision reversal.
- OpenAPI contract E2E: **13/13 passed**.
- PayrollPage spec command: **104 files, 896 tests passed**.
- API and web typecheck/lint passed; Prisma client, OpenAPI model, and API client generation passed.
- The single final `pnpm test` run reported **150 suites passed, 4 failed, 1 skipped; 1,808 tests passed, 9 failed, 7 skipped**. Two failures were Phase 28B follow-ups: the isolation sweep did not yet map the five new ID routes, and the static idempotency check required keys on approve/cancel. The sweep fixture was extended and `@RequiresIdempotencyKey` added to approve/reject/cancel; the focused isolation sweep passed **5/5** and static check **3/3** afterward.
- The other failures were `phase14-invoicing.e2e.spec.ts` (one concurrent post/cancel round returned `INVALID_STATUS_TRANSITION` instead of `SALES_ORDER_NOT_CANCELLABLE`) and `session-access.e2e.spec.ts` (setup timed out at 5 seconds under full-suite load, with a transaction-start timeout). Phase 14 source and test files are unchanged from the branch base; the focused Phase 14 suite passed **18/18** afterward. Focused session-access passed **13/13** afterward. The full suite was not rerun after the targeted follow-ups.

There is no standalone chart-provisioning spec in the repository; new-company leave defaults are exercised through the MariaDB E2E provisioning path. Visual verification was not performed.
