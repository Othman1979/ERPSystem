// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { LoginPage } from './LoginPage';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ login: vi.fn() }) }));

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('LoginPage branding', () => {
  it('shows stored branding above the form', () => {
    localStorage.setItem('erp.lastBranding', JSON.stringify({
      nameAr: 'شركة أ',
      nameEn: 'Company A',
      logo: 'data:image/png;base64,abc',
    }));
    const html = renderToStaticMarkup(<LoginPage onSwitchToRegister={() => undefined} />);
    expect(html).toContain('Company A');
    expect(html).toContain('data:image/png;base64,abc');
    localStorage.clear();
  });

  it('shows the default brand when nothing is stored', () => {
    localStorage.removeItem('erp.lastBranding');
    expect(renderToStaticMarkup(<LoginPage onSwitchToRegister={() => undefined} />)).toContain('ERP Cloud');
  });
});
