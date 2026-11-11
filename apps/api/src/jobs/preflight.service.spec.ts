import { compareMigrations } from './preflight.service.js';

describe('preflight: migrations (ADR-010 §10.1)', () => {
  const at = new Date('2026-11-11T00:00:00Z');

  it('lists folders not applied, and rows that started but never finished', () => {
    const result = compareMigrations(
      ['20260101_a', '20260201_b', '20260301_c'],
      [
        { migration_name: '20260101_a', finished_at: at, rolled_back_at: null },
        { migration_name: '20260201_b', finished_at: null, rolled_back_at: null },
      ],
    );
    expect(result).toEqual({ pending: ['20260201_b', '20260301_c'], failed: ['20260201_b'] });
  });

  it('a rolled-back attempt is neither applied nor failed', () => {
    const result = compareMigrations(
      ['20260101_a'],
      [
        { migration_name: '20260101_a', finished_at: null, rolled_back_at: at },
        { migration_name: '20260101_a', finished_at: at, rolled_back_at: null },
      ],
    );
    expect(result).toEqual({ pending: [], failed: [] });
  });
});
