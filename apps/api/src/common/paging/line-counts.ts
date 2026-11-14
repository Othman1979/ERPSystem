/** One group of a `groupBy({ by: [parentKey], _count: { _all: true } })` over a lines table. */
export type LineCountGroup<K extends string> = { [P in K]: bigint } & { _count: { _all: number } };

/**
 * Adds `_count: { lines }` to a page of documents, counting the lines of
 * these documents only (Wave 4A / 5A). Prisma's `_count` include compiles to
 * a LEFT JOIN on `SELECT ... COUNT(*) FROM <lines> WHERE 1=1 GROUP BY ...`:
 * an aggregate over every tenant's lines, whatever the page. Here `groupBy`
 * reads ≤ pageSize documents' lines through the unique (tenant_id, <parent>_id,
 * ...) index. Pass a groupBy on the tenant-scoped client (it adds tenant_id)
 * filtered by `<parentKey> IN ids`. Same response shape as the include.
 */
export async function withLineCounts<T extends { id: bigint }, K extends string, G extends LineCountGroup<K>>(
  rows: T[],
  parentKey: K,
  groupBy: (ids: bigint[]) => Promise<readonly G[]>,
): Promise<Array<T & { _count: { lines: number } }>> {
  if (rows.length === 0) return [];
  const groups = await groupBy(rows.map((r) => r.id));
  const byParent = new Map(groups.map((g) => [g[parentKey] as bigint, g._count._all]));
  return rows.map((r) => ({ ...r, _count: { lines: byParent.get(r.id) ?? 0 } }));
}
