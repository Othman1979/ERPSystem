import {
  LINE_DESCRIPTIONS,
  lineDescription,
  lineDescriptionKey,
  localizedLineDescription,
} from './line-description.js';

describe('journal line descriptions', () => {
  it('uses unique English descriptions for exact reverse lookup', () => {
    const entries = Object.entries(LINE_DESCRIPTIONS);
    expect(new Set(entries.map(([, description]) => description.en)).size).toBe(entries.length);
    for (const [key] of entries) {
      expect(lineDescriptionKey(lineDescription(key))).toBe(key);
    }
  });

  it('leaves manual or unknown descriptions without a key', () => {
    expect(lineDescriptionKey('Manual journal note')).toBeNull();
    expect(lineDescriptionKey(null)).toBeNull();
  });

  it('preserves producer text and localizes known line descriptions', () => {
    expect(lineDescription('journal.line.creditSale')).toBe('Credit sale');
    expect(localizedLineDescription('Credit sale', 'ar')).toBe('مبيعات آجلة');
    expect(localizedLineDescription('Manual journal note', 'ar')).toBe('Manual journal note');
  });
});
