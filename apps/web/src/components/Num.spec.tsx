import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Num } from './Num';

describe('Num', () => {
  it('uses the shared numeric styling for the value', () => {
    const html = renderToStaticMarkup(<Num>-200.000</Num>);
    expect(html).toContain('class="num"');
    expect(html).toContain('-200.000');
  });
});
