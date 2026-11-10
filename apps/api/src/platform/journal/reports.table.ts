import { L, type ReportTable } from '../printing/report-table.js';
import { blankZero, isoDate, localName, periodMeta } from '../printing/report-meta.js';
import type { ReportRange, ReportsService } from './reports.service.js';

type Lang = 'ar' | 'en';
type TrialBalance = Awaited<ReturnType<ReportsService['trialBalance']>>;
type GeneralLedger = Awaited<ReturnType<ReportsService['generalLedger']>>;
type PartyStatement = Awaited<ReturnType<ReportsService['partyStatement']>>;

/**
 * Trial balance JSON → export table: per account the opening balance, the
 * period's movements and the closing balance, each as debit / credit.
 */
export function trialBalanceTable(data: TrialBalance, lang: Lang, range: ReportRange): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    title: t('ميزان المراجعة', 'Trial balance'),
    meta: [periodMeta(lang, range.from, range.to)],
    fileName: 'trial-balance',
    orientation: 'landscape',
    columns: [
      { key: 'code', label: t('الرمز', 'Code'), width: 50 },
      { key: 'name', label: t('الحساب', 'Account') },
      { key: 'openingDebit', label: t('أول المدة مدين', 'Opening debit'), kind: 'amount' },
      { key: 'openingCredit', label: t('أول المدة دائن', 'Opening credit'), kind: 'amount' },
      { key: 'periodDebit', label: t('الحركة مدين', 'Movement debit'), kind: 'amount' },
      { key: 'periodCredit', label: t('الحركة دائن', 'Movement credit'), kind: 'amount' },
      { key: 'closingDebit', label: t('آخر المدة مدين', 'Closing debit'), kind: 'amount' },
      { key: 'closingCredit', label: t('آخر المدة دائن', 'Closing credit'), kind: 'amount' },
    ],
    rows: data.rows.map((r) => ({
      code: r.code,
      name: localName(lang, r.nameAr, r.nameEn),
      openingDebit: r.openingDebit,
      openingCredit: r.openingCredit,
      periodDebit: r.periodDebit,
      periodCredit: r.periodCredit,
      closingDebit: r.closingDebit,
      closingCredit: r.closingCredit,
    })),
    totals: [
      {
        name: t('المجموع', 'Total'),
        openingDebit: data.totals.openingDebit,
        openingCredit: data.totals.openingCredit,
        periodDebit: data.totals.periodDebit,
        periodCredit: data.totals.periodCredit,
        closingDebit: data.totals.closingDebit,
        closingCredit: data.totals.closingCredit,
      },
    ],
  };
}

/** Opening row, movements, totals and closing row shared by the two statements. */
function statementRows(
  data: GeneralLedger | PartyStatement,
  lang: Lang,
  line: (r: (GeneralLedger | PartyStatement)['rows'][number]) => Record<string, string>,
): Pick<ReportTable, 'rows' | 'totals'> {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    rows: [
      {
        description: t('رصيد أول المدة', 'Opening balance'),
        debit: blankZero(data.openingDebit),
        credit: blankZero(data.openingCredit),
        balance: data.openingBalance,
        _bold: true,
      },
      ...data.rows.map((r) => ({
        date: isoDate(r.entryDate),
        entryNo: r.entryNo ?? '',
        description: r.description ?? '',
        debit: blankZero(r.debit),
        credit: blankZero(r.credit),
        balance: r.balance,
        ...line(r),
      })),
    ],
    totals: [
      { description: t('مجموع الحركات', 'Movements'), debit: data.totalDebit, credit: data.totalCredit },
      {
        description: t('رصيد آخر المدة', 'Closing balance'),
        debit: blankZero(data.closingDebit),
        credit: blankZero(data.closingCredit),
        balance: data.closingBalance,
      },
    ],
  };
}

/** Account statement (general ledger) JSON → export table. */
export function generalLedgerTable(data: GeneralLedger, lang: Lang, range: ReportRange): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const account = `${data.account.code} ${localName(lang, data.account.nameAr, data.account.nameEn)}`;
  return {
    title: t('كشف حساب', 'Account statement'),
    meta: [`${t('الحساب', 'Account')}: ${account}`, periodMeta(lang, range.from, range.to)],
    fileName: `account-statement-${data.account.code}`,
    columns: [
      { key: 'date', label: t('التاريخ', 'Date'), kind: 'date' },
      { key: 'entryNo', label: t('رقم القيد', 'Entry no.'), width: 80 },
      { key: 'description', label: t('البيان', 'Description') },
      { key: 'debit', label: t('مدين', 'Debit'), kind: 'amount' },
      { key: 'credit', label: t('دائن', 'Credit'), kind: 'amount' },
      { key: 'balance', label: t('الرصيد', 'Balance'), kind: 'amount' },
    ],
    ...statementRows(data, lang, () => ({})),
  };
}

/** Party statement JSON → export table; `party` names the customer / supplier in the header. */
export function partyStatementTable(
  data: PartyStatement,
  lang: Lang,
  range: ReportRange,
  party: { code: string; nameAr: string; nameEn: string | null } | null,
): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const who = data.partyType === 'CUSTOMER' ? t('العميل', 'Customer') : t('المورد', 'Supplier');
  const name = party ? `${party.code} ${localName(lang, party.nameAr, party.nameEn)}` : data.partyId;
  return {
    title: t('كشف حساب', 'Account statement'),
    meta: [`${who}: ${name}`, periodMeta(lang, range.from, range.to)],
    fileName: `statement-${party?.code ?? data.partyId}`,
    columns: [
      { key: 'date', label: t('التاريخ', 'Date'), kind: 'date' },
      { key: 'entryNo', label: t('رقم القيد', 'Entry no.'), width: 80 },
      { key: 'account', label: t('الحساب', 'Account'), width: 60 },
      { key: 'description', label: t('البيان', 'Description') },
      { key: 'debit', label: t('مدين', 'Debit'), kind: 'amount' },
      { key: 'credit', label: t('دائن', 'Credit'), kind: 'amount' },
      { key: 'balance', label: t('الرصيد', 'Balance'), kind: 'amount' },
    ],
    ...statementRows(data, lang, (r) => ({ account: 'accountCode' in r ? r.accountCode : '' })),
  };
}
