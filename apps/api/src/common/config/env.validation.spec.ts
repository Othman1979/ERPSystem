import { apiDocsEnabled, productionProblems, trustProxySetting, validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('accepts minimal config and applies defaults', () => {
    const env = validateEnv({
      DATABASE_URL: 'mysql://root@localhost:3306/db',
      JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars',
    });
    expect(env.API_PORT).toBe(3001);
    expect(env.CORS_ORIGIN).toBe('http://localhost:5173');
    expect(env.NODE_ENV).toBe('development');
    expect(env.TRUST_PROXY).toBe('loopback');
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
    BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  };

  it('accepts a complete production configuration; docs are off, only a local proxy trusted', () => {
    const env = validateEnv(good);
    expect([env.EINVOICE_WORKER, env.TRUST_PROXY, apiDocsEnabled(env)]).toEqual(['off', 'loopback', false]);
    expect(env.BACKUP_ENCRYPTION_KEY).toBe(good.BACKUP_ENCRYPTION_KEY);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS: 'on' })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'development', API_DOCS: undefined })).toBe(true);
  });

  it.each([
    ['JWT_ACCESS_SECRET', { JWT_ACCESS_SECRET: 'short-but-16-chars!' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: 'http://erp.example.jo' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: 'https://localhost:5173' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: 'not a url' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: 'https://erp.example.jo/' }],
    ['CORS_ORIGIN', { CORS_ORIGIN: 'https://erp.example.jo/app' }],
    ['EINVOICE_ENC_KEY', { EINVOICE_ENC_KEY: undefined }],
    ['EINVOICE_ENC_KEY', { EINVOICE_ENC_KEY: Buffer.alloc(16).toString('base64') }],
    ['EINVOICE_WORKER', { EINVOICE_WORKER: 'on' }],
    ['TRUST_PROXY', { TRUST_PROXY: 'true' }],
    ['BACKUP_ENCRYPTION_KEY', { BACKUP_ENCRYPTION_KEY: undefined }],
    ['BACKUP_ENCRYPTION_KEY', { BACKUP_ENCRYPTION_KEY: '' }],
    ['BACKUP_ENCRYPTION_KEY', { BACKUP_ENCRYPTION_KEY: Buffer.alloc(16, 9).toString('base64') }],
  ])('refuses to start without a sound %s', (name, change) => {
    expect(() => validateEnv({ ...good, ...change })).toThrow(new RegExp(`${name}: `));
  });

  it('says which origin it expects', () => {
    expect(() => validateEnv({ ...good, CORS_ORIGIN: 'https://ERP.example.jo:443/' })).toThrow(
      /\(here: https:\/\/erp\.example\.jo\)/,
    );
  });

  it('names every problem at once', () => {
    const problems = productionProblems(validateEnv({ ...good, NODE_ENV: 'test' }));
    expect(problems).toEqual([]); // the rules are production only
    expect(() => validateEnv({ ...good, CORS_ORIGIN: 'http://x', EINVOICE_WORKER: 'on' })).toThrow(
      /CORS_ORIGIN: .*; EINVOICE_WORKER: /,
    );
  });

  it('accepts named proxies or a hop count in production (ADR-011)', () => {
    expect(validateEnv({ ...good, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).TRUST_PROXY).toBe('loopback, 10.0.0.0/8');
    expect(validateEnv({ ...good, TRUST_PROXY: '1' }).TRUST_PROXY).toBe('1');
    expect(validateEnv({ ...good, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe('false');
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
      'loopback',
      undefined,
    ]);
    expect(() => validateEnv({ DATABASE_URL: '', JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars' })).toThrow(
      /DATABASE_URL/,
    );
  });
});

describe('trustProxySetting', () => {
  it.each([
    ['false', false],
    ['', false],
    ['true', true],
    ['1', 1],
    ['loopback', 'loopback'],
    [' loopback, 10.0.0.0/8 ', 'loopback, 10.0.0.0/8'],
  ])('%j gives %j', (value, expected) => {
    expect(trustProxySetting(value)).toEqual(expected);
  });
});

describe('the port (ADR-010 §10.5)', () => {
  const base = { DATABASE_URL: 'mysql://root@localhost:3306/db', JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars' };

  it("listens on the host's PORT unless API_PORT is set", () => {
    expect(validateEnv({ ...base, PORT: '41234' }).API_PORT).toBe(41234);
    expect(validateEnv({ ...base, PORT: '41234', API_PORT: '3001' }).API_PORT).toBe(3001);
    expect(validateEnv(base).API_PORT).toBe(3001);
  });
});
