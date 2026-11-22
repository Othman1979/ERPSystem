// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { ActiveTag } from './StatusTag';

describe('ActiveTag', () => {
  it('renders active and suspended labels in Arabic', async () => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage('ar');
    try {
      expect(renderToStaticMarkup(<ActiveTag active />)).toContain('نشط');
      expect(renderToStaticMarkup(<ActiveTag active={false} />)).toContain('موقوف');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});
