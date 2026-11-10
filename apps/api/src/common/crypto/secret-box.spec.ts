import { randomBytes } from 'node:crypto';
import { openSecret, sealSecret } from './secret-box.js';

describe('secret box (AES-256-GCM)', () => {
  const key = randomBytes(32).toString('base64');

  it('opens what it sealed, and never stores the plain text', () => {
    const sealed = sealSecret('my-secret-key', key);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('my-secret-key');
    expect(openSecret(sealed, key)).toBe('my-secret-key');
    expect(sealSecret('my-secret-key', key)).not.toBe(sealed); // fresh IV each time
  });

  it('refuses a wrong key or a changed text', () => {
    const sealed = sealSecret('my-secret-key', key);
    expect(() => openSecret(sealed, randomBytes(32).toString('base64'))).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => openSecret(parts.join('.'), key)).toThrow();
  });

  it('needs a 32-byte key', () => {
    expect(() => sealSecret('x', undefined)).toThrow(/EINVOICE_ENC_KEY/);
    expect(() => sealSecret('x', Buffer.from('short').toString('base64'))).toThrow(/EINVOICE_ENC_KEY/);
  });
});
