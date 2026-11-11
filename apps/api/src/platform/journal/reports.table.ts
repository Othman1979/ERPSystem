import { sum } from '../../common/decimal/decimal.utils.js';
import { L, type ReportTable } from '../printing/report-table.js';
import { blankZero, isoDate, localName, periodMeta } from '../printing/report-meta.js';
import type { ReportRange, ReportsService } from './reports.service.js';

type Lang = 'ar' | 'en';
type TrialBalance = Awaited<ReturnType<ReportsService['trialBalance']>>;
type GeneralLedger = Awaited<ReturnType<ReportsService['generalLedger']>>;
type PartyStatement = Awaited<ReturnType<ReportsService['partyStatement']>>;

/** Trial balance JSON → export table (one row per account, debit/credit totals). */
export function trialBalanceTable(data: TrialBalance, lang: Lang, range: ReportRange): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    title: t('ميزان المراجعة', 'Trial balance'),
    meta: [periodMeta(lang, range.from, range.to)],
    fileName: 'trial-balance',
    columns: [
      { key: 'code', label: t('الرمز', 'Code'), width: 50 },
      { key: 'name', label: t('الحساب', 'Account') },
      { key: 'debit', label: t('مدين', 'Debit'), kind: 'amount' },
      { key: 'credit', label: t('دائن', 'Credit'), kind: 'amount' },
      { key: 'balance', label: t('الرصيد', 'Balance'), kind: 'amount' },
    ],
    rows: data.rows.map((r) => ({
      code: r.code,
      name: localName(lang, r.nameAr, r.nameEn),
      debit: r.totalDebit,
      credit: r.totalCredit,
      balance: r.balance,
    })),
    totals: [{ name: t('المجموع', 'Total'), debit: data.totals.debit, credit: data.totals.credit }],
  };
}

/** General ledger JSON → export table: opening row, lines with running balance, totals. */
export function generalLedgerTable(data: GeneralLedger, lang: Lang, range: ReportRange): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const account = `${data.account.code} ${localName(lang, data.account.nameAr, data.account.nameEn)}`;
  return {
    title: t('دفتر الأستاذ', 'General ledger'),
    meta: [`${t('الحساب', 'Account')}: ${account}`, periodMeta(lang, range.from, range.to)],
    fileName: `general-ledger-${data.account.code}`,
    columns: [
      { key: 'date', label: t('التاريخ', 'Date'), kind: 'date' },
      { key: 'entryNo', label: t('رقم القيد', 'Entry no.'), width: 80 },
      { key: 'description', label: t('البيان', 'Description') },
      { key: 'debit', label: t('مدين', 'Debit'), kind: 'amount' },
      { key: 'credit', label: t('دائن', 'Credit'), kind: 'amount' },
      { key: 'balance', label: t('الرصيد', 'Balance'), kind: 'amount' },
    ],
    rows: [
      { description: t('رصيد افتتاحي', 'Opening balance'), balance: data.openingBalance, _bold: true },
      ...data.rows.map((r) => ({
        date: isoDate(r.entryDate),
        entryNo: r.entryNo ?? '',
        description: r.description ?? '',
        debit: blankZero(r.debit),
        credit: blankZero(r.credit),
        balance: r.balance,
      })),
    ],
    totals: [
      {
        description: t('المجموع والرصيد الختامي', 'Totals and closing balance'),
        debit: sum(data.rows.map((r) => r.debit)).toString(),
        credit: sum(data.rows.map((r) => r.credit)).toString(),
        balance: data.closingBalance,
      },
    ],
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
    rows: [
      { description: t('رصيد افتتاحي', 'Opening balance'), balance: data.openingBalance, _bold: true },
      ...data.rows.map((r) => ({
        date: isoDate(r.entryDate),
        entryNo: r.entryNo ?? '',
        account: r.accountCode,
        description: r.description ?? '',
        debit: blankZero(r.debit),
        credit: blankZero(r.credit),
        balance: r.balance,
      })),
    ],
    totals: [
      {
        description: t('المجموع والرصيد الختامي', 'Totals and closing balance'),
        debit: data.totalDebit,
        credit: data.totalCredit,
        balance: data.closingBalance,
      },
    ],
  };
}
