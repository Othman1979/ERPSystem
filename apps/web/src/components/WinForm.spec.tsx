import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WinField, WinGroup, WinPanel } from './WinForm';

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
});
