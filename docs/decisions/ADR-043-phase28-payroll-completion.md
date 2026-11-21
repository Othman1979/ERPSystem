# ADR-043 — Phase 28: income tax withholding, leave and end of service

**Status:** Accepted (owner delegated the rule choices to the law and Jordanian practice, 2026-11-21)  
**Date:** 2026-11-21  
**Amends:** ADR-041 §7 and its "Deferred" list.

## Sources (jolaws.com, read 2026-11-21)
- Income Tax Law No. 34/2014: art. 4 (end-of-service exemption), art. 9 (personal exemptions), art. 11 (brackets, national contribution, rounding), art. 12/a/4 (employment income withheld per executive instructions).
- Executive Instructions No. 2/2019 — income tax withholding: art. 3 (monthly withholding table), art. 4 (end-of-service withholding), art. 5 (employee family certificate), art. 6 (annual statement and leaving certificate), art. 9 (JOD 2,000 per disabled person).
- Labour Law No. 8/1996: art. 32 (end of service for employees not covered by SSC), art. 61–63 (annual leave, split, cash for unused leave at termination), art. 65 (sick leave), art. 66 (Hajj, paternity), art. 70 (maternity).
- Social Security Law No. 1/2014: art. 42–46 (maternity insurance: SSC pays the insured woman an allowance equal to her last subject wage).
- PwC Worldwide Tax Summaries, Jordan individual (last reviewed 05/07/2026): no deductible employment expenses besides the personal exemptions.

## Decision

### 28A — automatic income tax withholding (Instructions 2/2019 art. 3)
1. **Monthly method, not cumulative.** Each month the employer withholds on that month's taxable pay above 1/12 of the employee's annual exemptions. Non-monthly amounts (annual bonus, housing paid once) are added to the month they are paid in, as art. 3 requires. Year-end differences are settled by the employee's own return (art. 6 certificate).
2. **Taxable pay** = basic + earnings flagged `taxSubject` − deductions flagged `taxSubject` (time deductions such as absence reduce taxable pay; advance repayments and penalties do not). Employee SSC is not deducted.
3. **Monthly exemption** = round3((personal + dependants if the employee supports dependants + employee's other annual exemption) / 12). Personal JOD 9,000 and dependants JOD 9,000 (law art. 9/a/1–2). The documented-expense exemptions (JOD 1,000 each, max 3,000) are claimed on the annual return, not in payroll. "Other annual exemption" covers approved amounts such as JOD 2,000 per disabled person (instructions art. 9).
4. **Monthly brackets** on the excess (instructions art. 3, cumulative upper bounds): 5% to 416, 10% to 832, 15% to 1,248, 20% to 1,664, 25% to 83,333, 30% above. **National contribution** 1% of the excess above JOD 16,666 per month. Tax withheld = round3(bracket tax + national contribution), posted to PAYROLL_TAX_PAYABLE.
5. **Dated settings.** Exemption amounts, brackets and the national contribution threshold/rate live on the dated payroll settings row; the accountant creates a new row when the law changes.
6. **Manual override stays.** The accountant may override the computed tax on a draft line; the line is marked manual and keeps the amount on recompute until the override is cleared. Employees can be marked not subject to withholding.

### 28B — leave
1. **Types (seeded per company, editable):** annual, sick, maternity, paternity, Hajj, unpaid.
2. **Annual entitlement:** 14 working days per service year, 21 after five continuous years with the employer; prorated in the first year; weekly rest days and official holidays are not counted (art. 61). Unused days carry to the next year only and then lapse (art. 61/c).
3. **Other entitlements:** sick 14 days full pay, plus 14 if hospitalised (art. 65); paternity 3 days; Hajj 14 days once after five years (art. 66); maternity 10 weeks (art. 70); unpaid leave by agreement.
4. **Requests** are dated, counted in working days against a company calendar (weekly rest day and holidays), and approved before they affect balances or payroll.
5. **Payroll effect:** unpaid leave days are deducted from the month's pay at the daily rate. Maternity days are not paid by the employer: SSC pays the employee an allowance equal to her wage (SSC law art. 45), so the run deducts those days.
6. **Provision (IAS 19):** each posted run trues up an accrued-leave provision to unused annual days × daily wage (basic + fixed allowances / days per month). Dr leave expense, Cr leave provision.

### 28C — end of service and final settlement
1. **Entitlement (art. 32):** employees not covered by SSC get one month's last wage (basic + fixed allowances) per year of actual service, prorated for part years. SSC-covered employees get none by law.
2. **Provision (IAS 19):** each posted run trues up the end-of-service provision for non-SSC employees to service years × current wage. Dr end-of-service expense, Cr end-of-service provision.
3. **Final settlement document** on leaving: last days' pay, cash for unused annual leave (art. 63), end of service; posted through `PostingService` against the provisions, paid as a separate entry. Correction by reversal only.
4. **End-of-service tax (instructions art. 4):** 100% exempt for service before 2010, 50% exempt for 2010–2014, first JOD 15,000 exempt for service from 2015; 9% on the remainder; plus 1% national contribution on what exceeds JOD 200,000.

## Consequences
- Three pull requests: 28A, 28B, 28C. New mapping keys arrive with 28B and 28C.
- Existing golden scenarios PY1–PY4 keep their manually entered tax as overrides; their numbers do not change.

## Deferred
Annual tax return preparation, documented-expense exemptions in payroll, attendance devices, multi-currency salaries, employee self-service.
