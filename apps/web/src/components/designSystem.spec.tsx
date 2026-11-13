import { DatePicker, Input, InputNumber, Radio, Select } from 'antd';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { Balance } from './Balance';
import { DocField, DocValue } from './DocLayout';
import { GridSelect } from './GridSelect';
import { openableRow } from './rowNav';
import { ActiveTag, StatusTag } from './StatusTag';

/** The `for` of the field's <label> and the id it points at. */
function labelTarget(html: string): { htmlFor: string; labelId: string } {
  const m = html.match(/<label id="([^"]+)" for="([^"]+)"/);
  if (!m) throw new Error(`no bound <label> in ${html}`);
  return { labelId: m[1], htmlFor: m[2] };
}

describe('DocField gives its control an accessible name (UI-02)', () => {
  it.each([
    ['Input', <Input key="c" />],
    ['InputNumber', <InputNumber key="c" />],
    ['Select', <Select key="c" options={[]} />],
    ['GridSelect', <GridSelect key="c" options={[]} />],
    ['DatePicker', <DatePicker key="c" />],
  ])('binds <label for> to the %s input', (_name, control) => {
    const html = renderToStaticMarkup(<DocField label="Customer">{control}</DocField>);
    const { htmlFor } = labelTarget(html);
    expect(html).toMatch(new RegExp(`<input[^>]*id="${htmlFor}"`));
  });

  it('marks a required field with aria-required and hides the visual asterisk', () => {
    const html = renderToStaticMarkup(
      <DocField label="Customer" required>
        <Input />
      </DocField>,
    );
    expect(html).toMatch(/<input[^>]*aria-required="true"/);
    expect(html).toContain('<span class="doc-field-req" aria-hidden="true">*</span>');
  });

  it('ties an error to the control and announces it', () => {
    const html = renderToStaticMarkup(
      <DocField label="Customer" error="Required">
        <Input />
      </DocField>,
    );
    const errorId = html.match(/<div id="([^"]+)" class="doc-field-error" role="alert">/)?.[1];
    expect(errorId).toBeTruthy();
    expect(html).toMatch(new RegExp(`<input[^>]*aria-describedby="${errorId}"`));
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
  });

  it('keeps an id the page already set', () => {
    const html = renderToStaticMarkup(
      <DocField label="Date">
        <Input id="invoice-date" />
      </DocField>,
    );
    expect(labelTarget(html).htmlFor).toBe('invoice-date');
  });

  it('names a radio group through aria-labelledby', () => {
    const html = renderToStaticMarkup(
      <DocField label="Payment">
        <Radio.Group options={['Credit', 'Cash']} optionType="button" />
      </DocField>,
    );
    const labelId = html.match(/<span id="([^"]+)" class="doc-field-label">/)?.[1];
    expect(labelId).toBeTruthy();
    expect(html).toMatch(new RegExp(`role="radiogroup"[^>]*aria-labelledby="${labelId}"|aria-labelledby="${labelId}"[^>]*role="radiogroup"`));
  });

  it('renders a read-only value with a plain label', () => {
    const html = renderToStaticMarkup(
      <DocField label="Total">
        <DocValue>12.000</DocValue>
      </DocField>,
    );
    expect(html).toContain('class="doc-field-label">Total</span>');
    expect(html).not.toContain('<label');
  });
});

describe('Balance shows credit balances with a suffix, red only on the wrong side', () => {
  it('suffixes a credit balance and drops the minus sign', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(<Balance net="-520" normalBalance="CREDIT" />);
    expect(html).toContain('520.000');
    expect(html).not.toContain('-520');
    expect(html).toContain('<span class="balance-side">Cr</span>');
    expect(html).not.toContain('balance-wrong-side');
  });

  it('uses «دائن» in Arabic', async () => {
    await i18n.changeLanguage('ar');
    const html = renderToStaticMarkup(<Balance net="-520" normalBalance="CREDIT" />);
    expect(html).toContain('<span class="balance-side">دائن</span>');
  });

  it('flags a debit-nature account in credit', () => {
    const html = renderToStaticMarkup(<Balance net="-5" normalBalance="DEBIT" />);
    expect(html).toContain('balance balance-wrong-side');
  });

  it('shows a debit balance with no suffix', () => {
    const html = renderToStaticMarkup(<Balance net="5" normalBalance="DEBIT" />);
    expect(html).not.toContain('balance-side');
  });
});

describe('StatusTag and ActiveTag (UI-04, UI-13)', () => {
  it('shows nothing for an active record and «غير نشط» for an inactive one', async () => {
    await i18n.changeLanguage('ar');
    expect(renderToStaticMarkup(<ActiveTag active />)).toBe('');
    expect(renderToStaticMarkup(<ActiveTag active={false} />)).toContain('غير نشط');
  });

  it('maps tones onto antd status colours', () => {
    expect(renderToStaticMarkup(<StatusTag tone="success">Posted</StatusTag>)).toContain('ant-tag-success');
    expect(renderToStaticMarkup(<StatusTag tone="danger">Suspended</StatusTag>)).toContain('ant-tag-error');
    expect(renderToStaticMarkup(<StatusTag>Customer</StatusTag>)).not.toMatch(/ant-tag-(success|error|warning|processing)/);
  });
});

describe('openableRow makes list rows keyboard-operable (UI-05)', () => {
  const key = (k: string, sameTarget = true) => {
    let prevented = false;
    const el = {};
    return {
      key: k,
      target: el,
      currentTarget: sameTarget ? el : {},
      preventDefault: () => {
        prevented = true;
      },
      get prevented() {
        return prevented;
      },
    };
  };

  it('is focusable and opens on click, Enter and Space', () => {
    const opened: number[] = [];
    const props = openableRow<number>((r) => opened.push(r))(7);
    expect(props.tabIndex).toBe(0);
    props.onClick();
    const enter = key('Enter');
    props.onKeyDown(enter as never);
    props.onKeyDown(key(' ') as never);
    expect(opened).toEqual([7, 7, 7]);
    expect(enter.prevented).toBe(true);
  });

  it('leaves keys pressed inside the row (buttons, inputs) alone', () => {
    const opened: number[] = [];
    const props = openableRow<number>((r) => opened.push(r))(7);
    props.onKeyDown(key('Enter', false) as never);
    props.onKeyDown(key('a') as never);
    expect(opened).toEqual([]);
  });
});
