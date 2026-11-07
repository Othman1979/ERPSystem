import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('accepts minimal config and applies defaults', () => {
    const env = validateEnv({ DATABASE_URL: 'mysql://root@localhost:3306/db' });
    expect(env.API_PORT).toBe(3001);
    expect(env.CORS_ORIGIN).toBe('http://localhost:5173');
    expect(env.NODE_ENV).toBe('development');
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'mysql://x', NODE_ENV: 'staging' }),
    ).toThrow(/NODE_ENV/);
  });
});
