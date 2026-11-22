import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormSection } from './FormDialog';

describe('FormSection', () => {
  it('renders a group-box legend, extra, full-row children, and its grid class', () => {
    const html = renderToStaticMarkup(
      <FormSection title="Details" extra={<button>Active</button>}>
        <div>List</div>
      </FormSection>,
    );

    expect(html).toContain('<fieldset class="form-section win-group">');
    expect(html).toContain('Details');
    expect(html).toContain('form-section-extra');
    expect(html).toContain('Active');
    expect(html).toContain('class="form-section-grid win-grid');
    expect(html).toContain('class="form-section-full-row"');
  });
});
