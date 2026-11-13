import { warnOnUntrustedProxy } from './proxy-warning.js';

describe('warnOnUntrustedProxy (ADR-010 §10.1, ADR-011)', () => {
  it('warns once when forwarded requests come from a proxy TRUST_PROXY does not name', () => {
    const warnings: string[] = [];
    const middleware = warnOnUntrustedProxy({ warn: (m) => warnings.push(m) });
    let passed = 0;
    const next = () => (passed += 1);

    middleware({ headers: {}, ips: [] }, {}, next);
    // Trusted: Express resolved the client from the header.
    middleware({ headers: { 'x-forwarded-for': '203.0.113.7' }, ips: ['203.0.113.7'] }, {}, next);
    expect(warnings).toHaveLength(0);
    // Not trusted: the header is there but ignored.
    middleware({ headers: { 'x-forwarded-for': '203.0.113.7' }, ips: [] }, {}, next);
    middleware({ headers: { 'x-forwarded-for': '203.0.113.8' }, ips: [] }, {}, next);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/TRUST_PROXY does not name/);
    expect(passed).toBe(4);
  });
});
