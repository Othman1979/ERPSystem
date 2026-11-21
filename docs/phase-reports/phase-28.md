# Phase 28 — Payroll completion

**Reference:** [ADR-043](../decisions/ADR-043-phase28-payroll-completion.md).
**Scope of this delivery:** 28A automatic Jordanian income-tax withholding, 28B leave balances, requests, payroll effects, and provisions, and 28C end-of-service provisions and final settlements.

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

## 28C — End of service and final settlement

The settled rules are recorded verbatim in [ADR-043 §28C](../decisions/ADR-043-phase28-payroll-completion.md#28c-implementation-rules-settled). The Phase 28C migration is `apps/api/prisma/migrations/20261121154619_phase28c_settlement/migration.sql`; it adds dated EOS tax settings, `PayrollLine.eosProvision`, company-scoped `PayrollSettlement` and its composite relations, accounts 2110/5208 and their mappings, `LEAVE_ENCASHMENT`, and `PAYROLL_SETTLEMENT` (`FS`) document numbering. Existing companies are backfilled in the migration with `INSERT ... SELECT`; new companies receive the same defaults through chart provisioning. The migration was applied only to isolated test database `erp_phase28c_test`; `erp_test` was not reset and preview was not touched.

### EOS1 — service split and tax

Non-SSC employee hired 01/01/2008 and leaving 31/12/2026, with basic JOD 1,000.000 plus fixed transport JOD 100.000:

- Service is 19.000000 years at a last wage of JOD 1,100.000, so EOS is `1,100 × 19 = 20,900.000`.
- The 6,940 service days split into 731 before 2010, 1,826 from 2010–2014, and 4,383 from 2015 onward.
- Taxable amount is `round3(0.5 × 20,900 × 1,826 / 6,940 + max(20,900 × 4,383 / 6,940 − 15,000, 0))` = **JOD 2,749.524**. EOS tax is **JOD 247.457**; national contribution is **JOD 0.000**.

### EOS2 — unpaid service and provision true-up

Non-SSC employee hired 01/03/2020 and leaving 31/08/2026, basic JOD 3,000.000, with an approved 10-calendar-day unpaid request earlier in 2026 and that period's run posted:

- Service years are **6.476712** and EOS is **JOD 19,430.136**. Taxable amount is **JOD 4,430.136**, EOS tax **JOD 398.712**, and national contribution **JOD 0.000**.
- July 2026 `eosProvision` is **JOD 19,175.343**; August is **JOD 19,430.136**, giving a **JOD 254.793** provision delta.
- Settlement posting debits 2110 for JOD 19,430.136, credits 2108 for JOD 398.712 and 2106 for JOD 19,031.424, and has no 5208 difference line. Payment debits 2106 and credits the bank for JOD 19,031.424. Reversing payment then posting restores the balances; the trial balance remains balanced.

### EN1 — leave encashment for an SSC-covered employee

SSC-covered employee hired 01/07/2026 and leaving 20/09/2026, basic JOD 600.000 plus fixed transport JOD 40.000 (not SSC-subject):

- July and August leave provisions are **JOD 25.387** and **JOD 50.773**.
- September run: basic **400.000**, transport **26.667**, `LEAVE_ENCASHMENT` **67.200**, gross **493.867**, SSC base **400.000**, employee SSC **30.000**, employer SSC **57.000**, tax **0.000**, net **463.867**, and ending leave provision **0.000**.
- The September leave-provision release is Dr 2109 / Cr 5207 for **JOD 50.773**. Final settlement is refused because the employee is SSC-covered.

### 28C acceptance and implementation

- Payroll E2E: **16/16 passed**, including PY1–PY7 and LV1–LV5 with all expected golden values unchanged, plus the leave-period payroll effects. Settlement E2E: **2/2 passed**, covering EOS1, EOS2, EN1, and the refusals for settlement before the leaving-period run is posted, a second active settlement, an SSC-covered employee, and payment before the settlement date. No required golden changed or failed.
- Settlement and payroll calculator specs: **18/18 passed**, including full-period proration returning exactly 1 in short and long months and the requested February, partial-February, and September-leaver cases. The leave-calculator spec remains covered by the 28B results above and the final full suite.
- Isolation sweep: **5/5 passed**; OpenAPI lifecycle contract: **14/14 passed**; static idempotency-route check: **3/3 passed**.
- Chart-template spec: **8/8 passed**. PayrollPage spec: **25/25 passed**, including eligible-employee filtering and settlement post/pay/reverse idempotency headers and date-only forms.
- API build, API typecheck/lint, web typecheck/lint, and API-client typecheck passed. Prisma client, OpenAPI Prisma models, and API-client generation passed.
- Settlement list/create, recompute, post, pay, reverse, and draft-delete routes are company-scoped; manage/post permissions, idempotency keys, audit events, DTOs, and bilingual UI/error messages are included. The PayrollPage settlement tab shows eligibility-filtered employee selection, service periods, EOS/tax/provision/net values, and permission-gated lifecycle actions. The existing payslip item renderer displays `LEAVE_ENCASHMENT` without a separate rendering path.
- No new run/deploy command was added; deploy the migration through the existing migration workflow and build the API before E2E tests.
- Visual verification was not performed. The single full root `pnpm test` is the final verification step after this report update; its outcome and any failure classification will be recorded in the delivery follow-up.

## Phase 28 final report (BUILD_PLAN §22)

1. **Completed outputs:** 28A income-tax withholding, 28B leave balances/requests/payroll deductions and provision, and 28C proration, leave encashment, EOS provisions, and settlement lifecycle are implemented.
2. **Tables and migrations:** 28A — `20261121133409_phase28a_income_tax`; 28B — `20261121141806_phase28b_leave`; 28C — `20261121154619_phase28c_settlement`. All are under `apps/api/prisma/migrations/`. The 28B/28C company defaults are backfilled for existing companies and provisioned for new companies.
3. **Endpoints and screens:** payroll tax and leave routes from the preceding sections; 28C `GET|POST /payroll/settlements`, `POST /payroll/settlements/:id/recompute|post|pay|reverse`, and `DELETE /payroll/settlements/:id`; PayrollPage includes payroll, leave, balances/settings, and final-settlement tabs.
4. **Acceptance tests:** PY1–PY7, LV1–LV5, EOS1, EOS2, EN1 and settlement refusals are unchanged and passed; isolation, OpenAPI, idempotency, calculators, chart-template and PayrollPage results are listed above. The one required full `pnpm test` is pending and will be recorded after it runs.
5. **Operational commands:** no new commands. Build the API before E2E runs; use the standard Prisma migration deployment process.
6. **Known issues and technical debt:** visual verification was not performed. Any failures from the final full suite will be classified in the follow-up; no 28C design deviation or failed golden is currently known.
7. **Decisions:** [ADR-043](../decisions/ADR-043-phase28-payroll-completion.md) records 28A, 28B, and the settled 28C implementation rules.
8. **Next phase:** Phase 28 is complete; no later phase was started. Existing owner follow-ups (Phase 10 items and accountant review of golden scenarios) remain as listed in `CLAUDE.md`.
