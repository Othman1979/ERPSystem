import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: false }));

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../components/CompanyProfileForm', () => ({
  useCompany: () => ({ data: { consignmentEnabled: state.enabled }, isLoading: false }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { ConsignmentPage } = await import('./ConsignmentPage');

describe('ConsignmentPage', () => {
  it('hides all temporary-receipt content when the company setting is off', () => {
    state.enabled = false;
    expect(renderToStaticMarkup(<MemoryRouter><ConsignmentPage /></MemoryRouter>)).toBe('');
  });
});
