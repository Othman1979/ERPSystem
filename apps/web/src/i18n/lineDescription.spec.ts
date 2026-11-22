import { describe, expect, it } from 'vitest';
import { entryDescription } from './entryDescription';
import { ar, en } from './locales';
import i18n from './index';

const LINE_KEYS = [
  'journal.line.creditPurchase',
  'journal.line.cashPurchase',
  'journal.line.invoiceVsGoodsReceived',
  'journal.line.cashSale',
  'journal.line.creditSale',
  'journal.line.cashRefund',
  'journal.line.creditNote',
  'journal.line.cashRefundFromSupplier',
  'journal.line.purchaseReturnCreditNote',
  'journal.line.productionOutput',
  'journal.line.productionMaterials',
  'journal.line.appliedProductionCost',
  'journal.line.productionMaterialsBack',
  'journal.line.appliedProductionCostReversed',
  'journal.line.productionOutputOut',
  'journal.line.basicSalaries',
  'journal.line.employerSocialSecurity',
  'journal.line.socialSecurityPayable',
  'journal.line.incomeTaxWithheld',
  'journal.line.netSalariesPayable',
  'journal.line.leaveProvisionExpense',
  'journal.line.accruedLeaveProvision',
  'journal.line.endOfServiceProvisionExpense',
  'journal.line.endOfServiceProvision',
  'journal.line.stockRevaluation',
] as const;

function localeValue(locale: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, locale);
}

describe('journal line descriptions', () => {
  it('has matching Arabic and English translations for every catalog key', () => {
    for (const key of LINE_KEYS) {
      expect(localeValue(ar, key)).toEqual(expect.any(String));
      expect(localeValue(en, key)).toEqual(expect.any(String));
    }
  });

  it('renders a keyed line description in Arabic', () => {
    expect(
      entryDescription(i18n.getFixedT('ar'), {
        description: 'Credit sale',
        descriptionKey: 'journal.line.creditSale',
      }),
    ).toBe('مبيعات آجلة');
  });
});
