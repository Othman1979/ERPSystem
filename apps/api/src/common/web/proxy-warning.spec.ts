import { warnOnUntrustedProxy } from './proxy-warning.js';

describe('warnOnUntrustedProxy (ADR-010 §10.1)', () => {
  it('warns once when a proxied request arrives, and always lets requests through', () => {
    const warnings: string[] = [];
    const middleware = warnOnUntrustedProxy({ warn: (m) => warnings.push(m) });
    let passed = 0;
    const next = () => (passed += 1);

    middleware({ headers: {} }, {}, next);
    expect(warnings).toHaveLength(0);
    middleware({ headers: { 'x-forwarded-for': '203.0.113.7' } }, {}, next);
    middleware({ headers: { 'x-forwarded-for': '203.0.113.8' } }, {}, next);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/TRUST_PROXY=0/);
    expect(passed).toBe(3);
  });
});
