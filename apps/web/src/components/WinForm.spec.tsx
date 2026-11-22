import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { ReportCriteria, WinField, WinGroup, WinPanel } from './WinForm';

describe('WinForm', () => {
  it('renders fieldset legends, labels, grid columns, and field size classes', () => {
    const html = renderToStaticMarkup(
      <WinPanel title="Payroll">
        <WinGroup title="Employee details" cols={3}>
          <WinField label="Employee" size="md">
            <input />
          </WinField>
        </WinGroup>
      </WinPanel>,
    );

    expect(html).toContain('<legend>Employee details</legend>');
    expect(html).toContain('Employee');
    expect(html).toContain('style="--cols:3"');
    expect(html).toContain('class="win-field win-w-md"');
  });

  it('renders compact report criteria with actions', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ReportCriteria actions={<button>Export</button>}>
          <WinField label="From date" size="date">
            <input />
          </WinField>
        </ReportCriteria>
      </I18nextProvider>,
    );

    expect(html).toContain('معايير التقرير');
    expect(html).toContain('From date');
    expect(html).toContain('class="win-actions"');
    expect(html).toContain('Export');
  });
});
