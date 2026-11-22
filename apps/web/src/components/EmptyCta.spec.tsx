import { describe, expect, it } from 'vitest';
import { emptyCtaForList } from './EmptyCta';

describe('emptyCtaForList', () => {
  it('uses the call to action only when no search or filter is active', () => {
    const cta = <button>New</button>;
    expect(emptyCtaForList(false, 'No results', cta)).toBe(cta);
    expect(emptyCtaForList(true, 'No results', cta)).toBe('No results');
  });
});
