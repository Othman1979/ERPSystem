# ADR-041: Phase 26 — payroll (salaries, allowances, deductions)

**Status:** accepted (owner, 2026-11-20). Exception to §2.3 (payroll was out of scope).

## Sources
- Social Security Corporation FAQ (ssc.gov.jo): employee 7.5%, employer 14.25%, +1% employer for hazardous work; subject wage not below the minimum wage.
- Labour Law No. 8/1996 art. 56, 59 (jolaws.com): 8 h/day, 48 h/week; overtime ≥ 125%; weekly rest day and holidays 150%.
- Income tax (PwC, Deloitte 2026): monthly withholding from annual brackets — not calculated here (owner).
- Odoo Payroll (structures, rules, inputs, work entries), Mozon ZHR: reference designs.

## Decision
1. **Company data** (ADR-040): employees, pay elements, payroll settings and runs belong to one company.
2. **Employee:** code, names, national id, SSC number, hire/leave dates, branch, cost centre, pay method (bank/cash) and IBAN, `sscCovered`, `sscHazardous`, active. Basic salary kept as a dated history (`effectiveFrom`): a raise is a new row.
3. **Pay elements** (accountant-defined): kind EARNING or DEDUCTION; amount type FIXED, PER_HOUR or PER_DAY with a rate factor (e.g. 1.25, 1.50); `sscSubject`; its own GL account. Seeded: overtime 125%, holiday overtime 150%, absence day, transport, housing, bonus, advance repayment, penalty.
4. **Recurring elements:** fixed allowance or deduction per employee with from/to dates (allowances, advance instalments).
5. **Inputs:** per employee and element, either per day (date + hours/days) or one monthly total; both are summed for the month.
6. **Settings per company, dated:** SSC employee/employer/hazardous rates, minimum and optional maximum subject wage, hours per month and days per month for hourly/daily rates. Seeded from the SSC FAQ; the accountant edits them.
7. **Income tax:** the accountant enters the month's amount per employee on the run. End-of-service and leave balances stay outside the system (owner).
8. **Monthly run:** draft for a month → compute lines (basic, earnings, SSC base, SSC employee/employer, tax, deductions, net; Decimal, round3) → edit inputs/tax → post one journal entry via `PostingService` → pay (bank or cash box) as a second entry. Correction: reverse the run (no direct edit of posted runs).
   - Dr salaries expense, earning accounts, employer SSC expense; Cr salaries payable, SSC payable (both shares), income tax payable, deduction accounts.
   - New mapping keys: PAYROLL_SALARIES_EXPENSE, PAYROLL_SSC_EXPENSE, PAYROLL_PAYABLE, PAYROLL_SSC_PAYABLE, PAYROLL_TAX_PAYABLE.
9. **Reports:** payslip (PDF, pdfmake), payroll register, monthly SSC sheet, tax withheld per employee.
10. **Permissions:** payroll.view, payroll.manage, payroll.post.

## Deferred
End-of-service, leave balances, attendance devices, tax calculation, multi-currency salaries, employee self-service.
