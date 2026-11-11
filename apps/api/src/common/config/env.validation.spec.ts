import { apiDocsEnabled, productionProblems, validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('accepts minimal config and applies defaults', () => {
    const env = validateEnv({
      DATABASE_URL: 'mysql://root@localhost:3306/db',
      JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars',
    });
    expect(env.API_PORT).toBe(3001);
    expect(env.CORS_ORIGIN).toBe('http://localhost:5173');
    expect(env.NODE_ENV).toBe('development');
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'mysql://x',
        NODE_ENV: 'staging',
        JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars',
      }),
    ).toThrow(/NODE_ENV/);
  });
});

describe('production rules (ADR-010 §10.1)', () => {
  const good = {
    DATABASE_URL: 'mysql://app@db:3306/erp',
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'https://erp.example.jo',
    EINVOICE_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  };

  it('accepts a complete production configuration; docs are off, the proxy untrusted', () => {
    const env = validateEnv(good);
    expect([env.EINVOICE_WORKER, env.TRUST_PROXY, apiDocsEnabled(env)]).toEqual(['off', 0, false]);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS: 'on' })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'development', API_DOCS: undefined })).toBe(true);
  });

  it.each([
    ['JWT_ACCESS_SECRET', { JWT_ACCESS_SECRET: 'short-but-16-chars!' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: 'http://erp.example.jo' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: 'https://localhost:5173' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: 'not a url' }],
    ['EINVOICE_ENC_KEY', { EINVOICE_ENC_KEY: undefined }],
    ['EINVOICE_ENC_KEY', { EINVOICE_ENC_KEY: Buffer.alloc(16).toString('base64') }],
    ['EINVOICE_WORKER', { EINVOICE_WORKER: 'on' }],
  ])('refuses to start without a sound %s', (name, change) => {
    expect(() => validateEnv({ ...good, ...change })).toThrow(new RegExp(`${name}: `));
  });

  it('names every problem at once', () => {
    const problems = productionProblems(validateEnv({ ...good, NODE_ENV: 'test' }));
    expect(problems).toEqual([]); // the rules are production only
    expect(() => validateEnv({ ...good, CORS_ORIGIN: 'http://x', EINVOICE_WORKER: 'on' })).toThrow(
      /CORS_ORIGIN: .*; EINVOICE_WORKER: /,
    );
  });

  it('reads TRUST_PROXY as a small count', () => {
    expect(validateEnv({ ...good, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(() => validateEnv({ ...good, TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
    expect(() => validateEnv({ ...good, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });
});

describe('empty values (NAME= in a .env file)', () => {
  it('mean unset: defaults apply, optional ones stay undefined, required ones are still required', () => {
    const env = validateEnv({
      DATABASE_URL: 'mysql://root@localhost:3306/db',
      JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars',
      API_DOCS: '',
      WEB_DIST_DIR: '',
      TRUST_PROXY: '',
      EINVOICE_ENC_KEY: '',
    });
    expect([env.API_DOCS, env.WEB_DIST_DIR, env.TRUST_PROXY, env.EINVOICE_ENC_KEY]).toEqual([
      undefined,
      undefined,
      0,
      undefined,
    ]);
    expect(() => validateEnv({ DATABASE_URL: '', JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars' })).toThrow(
      /DATABASE_URL/,
    );
  });
});
