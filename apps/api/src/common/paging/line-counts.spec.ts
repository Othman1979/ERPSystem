import { withLineCounts } from './line-counts.js';

describe('withLineCounts', () => {
  it('adds each row its own line count, 0 when it has none, in the page order', async () => {
    const asked: bigint[][] = [];
    const rows = [{ id: 7n, no: 'B' }, { id: 3n, no: 'A' }, { id: 9n, no: 'C' }];
    const out = await withLineCounts(rows, 'noteId', async (ids) => {
      asked.push(ids);
      return [
        { noteId: 3n, _count: { _all: 2 } },
        { noteId: 7n, _count: { _all: 5 } },
      ];
    });
    expect(asked).toEqual([[7n, 3n, 9n]]);
    expect(out).toEqual([
      { id: 7n, no: 'B', _count: { lines: 5 } },
      { id: 3n, no: 'A', _count: { lines: 2 } },
      { id: 9n, no: 'C', _count: { lines: 0 } },
    ]);
  });

  it('runs no query for an empty page', async () => {
    let calls = 0;
    const groupBy = async () => {
      calls++;
      return [] as { noteId: bigint; _count: { _all: number } }[];
    };
    expect(await withLineCounts([] as { id: bigint }[], 'noteId', groupBy)).toEqual([]);
    expect(calls).toBe(0);
  });
});
