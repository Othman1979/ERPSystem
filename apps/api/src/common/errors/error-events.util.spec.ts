import { clip, fingerprint, pathOnly, redact } from './error-events.util.js';

describe('error events: redaction and grouping (ADR-010 §10.3)', () => {
  it('blanks out passwords, tokens, secrets, Bearer and JWT values, and URL credentials', () => {
    const text = redact(
      'login failed password=hunter2 token: "abc123" api_key=K-1 Authorization: Bearer eyJhbGciOi.payload.sig ' +
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZw db mysql://app:s3cr3t@db:3306/erp secret=x',
    );
    for (const leaked of ['hunter2', 'abc123', 'K-1', 's3cr3t', 'eyJzdWIiOiIxIn0', 'payload.sig']) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain('password=[redacted]');
    expect(text).toContain('mysql://app:[redacted]@db:3306/erp');
    expect(text).toContain('Authorization: [redacted]');
    expect(redact('sent Bearer abc.def-ghi')).toBe('sent Bearer [redacted]');
  });

  it('keeps ordinary text as it is', () => {
    const plain = 'Cannot read properties of undefined (reading "lines") at invoice 42';
    expect(redact(plain)).toBe(plain);
  });

  it('cuts long text and drops query strings from paths', () => {
    expect(clip('x'.repeat(20), 10)).toHaveLength(10);
    expect(pathOnly('/api/v1/reports/trial-balance?from=2026-01-01&token=abc')).toBe('/api/v1/reports/trial-balance');
    expect(pathOnly(undefined)).toBeNull();
  });

  it('groups the same error with different numbers, and splits different places', () => {
    const stackA = 'Error: x\n    at InvoicesService.post (/app/dist/invoices.js:120:15)\n    at next';
    const stackB = 'Error: x\n    at InvoicesService.post (/app/dist/invoices.js:120:31)';
    const stackC = 'Error: x\n    at ReceiptsService.post (/app/dist/receipts.js:80:3)';
    const a = fingerprint('API', 'TypeError', 'No line 3 on invoice 120', stackA);
    expect(fingerprint('API', 'TypeError', 'No line 9 on invoice 7', stackB)).toBe(a);
    expect(fingerprint('API', 'TypeError', 'No line 3 on invoice 120', stackC)).not.toBe(a);
    expect(fingerprint('WEB', 'TypeError', 'No line 3 on invoice 120', stackA)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('groups Firefox and Safari stacks by function and file, not by column', () => {
    const firefoxA = 'TypeError: x\nrender@https://erp.example/assets/index-abc.js:1:2345\nmain@https://erp.example/assets/index-abc.js:1:99';
    const firefoxB = 'TypeError: x\nsave@https://erp.example/assets/index-abc.js:1:2345';
    const firefoxSameFnOtherColumn = 'TypeError: x\nrender@https://erp.example/assets/index-abc.js:1:2999';
    const a = fingerprint('WEB', 'TypeError', 'x', firefoxA);
    expect(fingerprint('WEB', 'TypeError', 'x', firefoxB)).not.toBe(a);
    expect(fingerprint('WEB', 'TypeError', 'x', firefoxSameFnOtherColumn)).toBe(a);
    const otherFile = 'TypeError: x\nrender@https://erp.example/assets/index-def.js:1:2345';
    expect(fingerprint('WEB', 'TypeError', 'x', otherFile)).not.toBe(a);
  });
});
