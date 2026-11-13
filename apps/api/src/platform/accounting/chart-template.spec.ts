import {
  ACCOUNT_MAPPING_KEYS,
  CHART_TEMPLATE,
  MAPPING_RULES,
  TEMPLATE_MAPPINGS,
  type TemplateAccount,
} from './chart-template.js';

/** Template account by code; fails the test if the code is missing. */
function templateAccount(code: string): TemplateAccount {
  const found = CHART_TEMPLATE.find((a) => a.code === code);
  if (!found) throw new Error(`template account ${code} is missing`);
  return found;
}

describe('chart template', () => {
  it('maps every mapping key to a template account that satisfies its rule', () => {
    for (const key of ACCOUNT_MAPPING_KEYS) {
      const account = templateAccount(TEMPLATE_MAPPINGS[key]);
      const rule = MAPPING_RULES[key];

      expect(rule.types).toContain(account.accountType);
      if (rule.controlType) {
        expect({ key, controlType: account.controlType }).toEqual({
          key,
          controlType: rule.controlType,
        });
      } else {
        expect({ key, controlType: account.controlType ?? null, isControl: account.isControl ?? false }).toEqual({
          key,
          controlType: null,
          isControl: false,
        });
      }
    }
  });

  it('sets the natures of §8.7: contra accounts 1202, 4102 and 4103 run opposite to their type', () => {
    expect(templateAccount('1202').normalBalance).toBe('CREDIT');
    expect(templateAccount('4102').normalBalance).toBe('DEBIT');
    expect(templateAccount('4103').normalBalance).toBe('DEBIT');

    const contra = new Set(['1202', '4102', '4103']);
    for (const account of CHART_TEMPLATE) {
      if (contra.has(account.code)) continue;
      const expected =
        account.accountType === 'ASSET' || account.accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
      expect({ code: account.code, normalBalance: account.normalBalance }).toEqual({
        code: account.code,
        normalBalance: expected,
      });
    }
  });

  it('gives every account an English name and a parent defined earlier in the template', () => {
    const seen = new Set<string>();
    for (const account of CHART_TEMPLATE) {
      expect({ code: account.code, nameEn: (account.nameEn ?? '').trim().length > 0 }).toEqual({
        code: account.code,
        nameEn: true,
      });
      if (account.parentCode !== undefined) {
        expect({ code: account.code, parentSeen: seen.has(account.parentCode) }).toEqual({
          code: account.code,
          parentSeen: true,
        });
      }
      seen.add(account.code);
    }
  });

  it('has a mapping rule for every mapping key', () => {
    expect(Object.keys(MAPPING_RULES).sort()).toEqual([...ACCOUNT_MAPPING_KEYS].sort());
    for (const key of ACCOUNT_MAPPING_KEYS) {
      expect(MAPPING_RULES[key].types.length).toBeGreaterThan(0);
    }
  });
});
