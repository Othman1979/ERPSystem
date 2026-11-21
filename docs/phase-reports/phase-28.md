# Phase 28 — Payroll completion

**Reference:** [ADR-043](../decisions/ADR-043-phase28-payroll-completion.md).
**Scope of this delivery:** 28A automatic Jordanian income-tax withholding only. Leave (28B) and end of service (28C) are not included.

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
- Full `pnpm test`: **151 suites passed, 2 failed, 1 skipped; 1,804 tests passed, 3 failed, 7 skipped**. The OpenAPI contract failure is the unchanged `DELETE /api/v1/document-locks/{docType}/{id}` 204 response, verified unchanged against `origin/main`. The purge-expired suite connected to `erp_test` and failed with `Table 'erp_test.document_edit_locks' doesn't exist`; no migration was applied to `erp_test`.

No PY1–PY4 fixtures required tax changes. Visual verification was not performed.
