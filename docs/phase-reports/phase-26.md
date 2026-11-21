# Phase 26 — Payroll

**Reference:** [ADR-041](../decisions/ADR-041-phase26-payroll.md).  
**Accountant approval:** Pending.

## PY1 hand calculation

Settings: employee SSC 7.5%, employer SSC 14.25%, minimum SSC wage JOD 290.000, 240 hours/month, 30 days/month.

| Employee | Basic | Earnings | Gross | SSC base | Employee SSC | Employer SSC | Tax | Deductions | Net |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 500.000 | 76.042 | 576.042 | 526.042 | 39.453 | 74.961 | 12.500 | 25.000 | 499.089 |
| B | 400.000 | 0.000 | 400.000 | 0.000 | 0.000 | 0.000 | 0.000 | 26.667 | 373.333 |
| **Run total** | **900.000** | **76.042** | **976.042** | **526.042** | **39.453** | **74.961** | **12.500** | **51.667** | **872.422** |

Derivation:

- A overtime: `500 / 240 = 2.083333` JOD/hour at six places. Daily inputs `6 + 4 = 10` hours. `10 × 2.083333 × 1.25 = 26.0416625`, rounded to `26.042`. Add transport `50.000` (not SSC-subject): earnings `76.042`, gross `576.042`.
- A SSC base: `500.000 + 26.042 = 526.042`. Employee SSC `526.042 × 7.5% = 39.45315 → 39.453`; employer SSC `526.042 × 14.25% = 74.960985 → 74.961`. Net: `576.042 − 39.453 − 12.500 − 25.000 = 499.089`.
- B absence: `400 / 30 = 13.333333` JOD/day at six places. `2 × 13.333333 = 26.666666 → 26.667`. B is not SSC-covered, so SSC is zero. Net: `400.000 − 26.667 = 373.333`.
- One monthly two-day absence movement rounds to JOD 26.667; two separate one-day vouchers each round to JOD 13.333, totaling JOD 26.666.
- Journal debits: salaries/earnings `976.042`, employer SSC `74.961`; total `1,051.003`. Credits: SSC payable `114.414`, tax payable `12.500`, advance asset `25.000`, absence deduction `26.667`, salaries payable `872.422`; total `1,051.003`.

## PY2

Payment of PY1's net amount is `872.422`. The payment entry debits salaries payable and credits the selected bank/cash account by the same amount. Reversing the paid run reverses the payment and payroll journal in one transaction; each affected balance returns to its pre-run value.

## PY3

- Inputs are locked after a run is posted.
- A second non-reversed run for the same company and period is refused.
- Concurrent posting serializes on the company/run rows; exactly one request may transition the draft run to posted.

## PY4 — daily movements

Employee A's basic salary is JOD 500.000, SSC-covered, with 240 hours per month. A recurring transport allowance of JOD 50.000 is not SSC-subject. Overtime on 2026-11-10 is 10 hours at 125%: `500 / 240 × 1.25 × 10 = 26.042`, subject to SSC. A fixed, non-SSC deduction for equipment misuse on 2026-11-20 is JOD 10.000. Income tax is JOD 12.500.

| Run line | Basic | SSC base | Employee SSC | Employer SSC | Tax | Net |
|---|---:|---:|---:|---:|---:|---:|
| Employee A | 500.000 | 526.042 | 39.453 | 74.961 | 12.500 | 514.089 |

The run entry debits salaries expense JOD 500.000, transport expense JOD 50.000, and employer SSC expense JOD 74.961; it credits SSC payable JOD 114.414, tax payable JOD 12.500, and payroll payable JOD 498.047. The overtime movement separately debits its element account and credits payroll payable JOD 26.042; the deduction separately debits payroll payable and credits its element account JOD 10.000. Paying the run debits payroll payable and credits the bank/cash account JOD 514.089. The employee statement's movement, run, and payment rows close at JOD 0.000.

## Revised PY1 entry layout

The employee-level PY1 values above remain unchanged. Overtime, absence, and advance repayment are separately posted movements. The payroll run entry debits salaries expense JOD 900.000, transport JOD 50.000, and employer SSC expense JOD 74.961; credits SSC payable JOD 114.414, tax payable JOD 12.500, and payroll payable JOD 898.047. The overtime movement separately posts JOD 26.042 (debit element account, credit payroll payable); the absence movement separately posts JOD 26.667 (debit payroll payable, credit element account); the advance repayment separately debits payroll payable and credits the advance account JOD 25.000.

Recurring rows on the employee card are limited to pay elements flagged as fixed allowances (EARNING + FIXED, e.g. transport, housing); all other elements are entered as posted movements.

## Scope

Tax-bracket computation, leave balances, and end-of-service benefits remain deferred per ADR-041. Scenario values above must not be changed to make tests pass; accountant review is pending.
