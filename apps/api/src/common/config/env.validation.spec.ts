import { trustProxySetting, validateEnv } from './env.validation.js';

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
