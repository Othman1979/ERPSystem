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

#### 28B implementation rules (settled)
Sources: Labour Law 8/1996 arts. 61, 65, 66, 70; SSC Law 1/2014 art. 45/b as amended by Law 24/2019 (employer owes no SSC share for maternity-allowance days; SSC pays wage/30 × 70 and deducts the employee's 7.5% from the allowance).

1. **Calendar.** Payroll settings (dated) gain `weeklyRestDays` (weekday numbers 0=Sun..6=Sat, default `[5]` Friday), `annualLeaveDays` 14, `annualLeaveDaysSenior` 21, `annualLeaveSeniorYears` 5. Official holidays are a company table (date, name); not seeded because they move every year.
2. **Leave types** (company-scoped, seeded, editable): `category` ∈ ANNUAL, SICK, MATERNITY, PATERNITY, HAJJ, UNPAID, OTHER; `countBasis` ∈ WORKING_DAYS, CALENDAR_DAYS; `maxDaysPerYear?`, `maxDaysPerRequest?`, `hospitalExtraDays?`, `payElementId?` (PER_DAY deduction used for payroll effect). Seeds: ANNUAL working; SICK working, 14/yr + 14 hospital; MATERNITY calendar, 70/request, element MATERNITY_LEAVE_DAY; PATERNITY working, 3/request; HAJJ working, 14/request, once per employment, needs 5 years' service at start date; UNPAID calendar, element UNPAID_LEAVE_DAY.
3. **Counting.** WORKING_DAYS = days in range minus weekly rest days minus company holidays; CALENDAR_DAYS = all days. ANNUAL and SICK requests lie in one calendar year (split at 31/12 otherwise) because their limits are per year; other categories may span years and count against their per-request limit as one request. Every request lies within hire/leave dates, and may not overlap another SUBMITTED/APPROVED request of the same employee.
4. **Annual entitlement per calendar year Y** = Σ over service days d in Y of (rate(d) / daysInYear(Y)), where rate = 14, or 21 from the 5th service anniversary on; plus balance adjustments for Y (opening balances when migrating). Rounded to 2 decimals (HALF_UP). Accrued-to-date uses the same formula up to the as-of date.
5. **Carry and lapse (art. 61).** Days taken in Y consume the carry-in first. carryInto(Y) = max(ent(Y−1) − max(taken(Y−1) − carryInto(Y−1), 0), 0). Older unused days lapse.
6. **Approval checks.** Annual: days ≤ carryInto(Y) + ent(Y) − taken(Y) (full-year entitlement may be used in advance). Sick: total ≤ 28 in Y and non-hospitalised ≤ 14. Per-request and once-per-employment limits as seeded. Excess must be requested as unpaid.
7. **Payroll effect.** No movements are created. The run reads APPROVED requests whose type has a pay element and adds PER_DAY deduction items linked to the request (`PayrollLineItem.leaveRequestId`): quantity = days of the request inside the period (calendar days for calendar types), but = `daysPerMonth` when the request covers the whole period, capped at `daysPerMonth`. MATERNITY deducts only for SSC-covered employees (non-covered ones get paid leave from the employer, art. 70). Both elements are SSC- and tax-subject, so SSC base and taxable pay drop with them.
8. **SSC floor.** The minimum-wage floor applies only when the SSC base is above zero; a month fully on maternity/unpaid leave has no contribution. A partial month below the minimum still uses the floor (known approximation).
9. **Cancellation.** Approved requests can be cancelled only while no POSTED/PAID run exists for any period they touch (same rule as movements).
10. **Provision (IAS 19).** On run posting, per employee: provision = round3(max(unused annual days as of period end, 0) × dailyWage), dailyWage = round6((basic + fixed-allowance amounts in force)/daysPerMonth); unused = carryInto(Y) + accruedToDate(Y) + adjustments(Y) − taken(Y up to period end). Stored on `PayrollLine.leaveProvision`. Delta per employee = this − the employee's value on the latest earlier POSTED/PAID run (0 if none). One extra journal entry per run: Dr PAYROLL_LEAVE_EXPENSE (5207, employee cost centre) / Cr PAYROLL_LEAVE_PROVISION (2109), sides swapped for negative deltas; reversed with the run.

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
