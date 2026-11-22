import { dropTableStatement } from './tenant-purge.service.js';

describe('tenant purge table identifiers', () => {
  it('quotes identifiers after validating their characters', () => {
    expect(dropTableStatement('journal_lines', 'BASE TABLE')).toBe('DROP TABLE IF EXISTS `journal_lines`');
    expect(dropTableStatement('legacy_view', 'VIEW')).toBe('DROP VIEW IF EXISTS `legacy_view`');
  });

  it.each(['table-name', 'table`name', 'table; DROP DATABASE x', ''])(
    'rejects an invalid identifier: %s',
    (identifier) => {
      expect(() => dropTableStatement(identifier, 'BASE TABLE')).toThrow('Invalid table identifier');
    },
  );
});
