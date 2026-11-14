/**
 * Reads an account or party statement whole through its keyset pages
 * (ADR-022 §4): follows `nextCursor` with the largest page and returns the
 * shape the statement had before paging — the first page's header and
 * `summary` fields at the top level, and every line in `rows` — so specs that
 * check a statement's figures keep checking exactly the same numbers.
 */
import request from 'supertest';

export interface WholeStatement {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the raw statement body, asserted by each spec
  body: any;
}

export async function wholeStatement(base: string, url: string, token: string): Promise<WholeStatement> {
  const sep = url.includes('?') ? '&' : '?';
  const rows: unknown[] = [];
  let first: Record<string, unknown> | null = null;
  let cursor: string | null = null;
  for (;;) {
    const res: request.Response = await request(base)
      .get(`${url}${sep}limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      .set({ Authorization: `Bearer ${token}` });
    if (res.status !== 200) return { status: res.status, body: res.body };
    const page = res.body as { summary?: Record<string, unknown> | null; items: unknown[]; nextCursor: string | null };
    if (!first) first = { ...(res.body as Record<string, unknown>), ...(page.summary ?? {}) };
    rows.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const { items: _items, nextCursor: _next, summary: _summary, ...header } = first!;
  return { status: 200, body: { ...header, rows } };
}

/** wholeStatement's body; throws unless every page answered 200. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the raw statement body, asserted by each spec
export async function statementBody(base: string, url: string, token: string): Promise<any> {
  const res = await wholeStatement(base, url, token);
  if (res.status !== 200) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
