import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Num } from './Num';

describe('Num', () => {
  it('renders the value as an isolated LTR run', () => {
    const html = renderToStaticMarkup(<Num>-200.000</Num>);
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('unicode-bidi:isolate');
    expect(html).toContain('-200.000');
  });
});
