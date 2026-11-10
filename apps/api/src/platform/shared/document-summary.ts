import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Shapes behind the documents' `summary()` methods (Phase 8): the sales and
 * purchases summaries, the tax summary and the dashboard all add up posted
 * documents through them, so the figures agree by construction.
 */
type Db = ReturnType<PrismaService['forTenant']>;
type Amount = { toString(): string } | null | undefined;

export type SummaryGroupBy = 'day' | 'month' | 'party' | 'item' | 'tax';

/** Both ends inclusive; calendar dates at UTC midnight. */
export interface SummaryRange {
  from: Date;
  to: Date;
}

export interface SummaryRef {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
}

export interface DocumentSummaryRow {
  /** yyyy-mm-dd, yyyy-mm, the party / item id, or `taxCategoryId|rate`. */
  key: string;
  /** Documents for day / month / party; lines for item / tax. */
  count: number;
  /** Base-unit quantity (item / tax grouping; zero otherwise). */
  qty: Decimal;
  net: Decimal;
  tax: Decimal;
  grand: Decimal;
  /** Cost of goods (sales documents; zero for purchases). */
  cost: Decimal;
  /** The party, item or tax category of the key. */
  ref: SummaryRef | null;
  taxRate: Decimal | null;
  einvoiceCode: string | null;
}

const dec = (v: Amount) => new Decimal(v?.toString() ?? 0);

export function summaryRow(
  key: string,
  count: number,
  sums: { qty?: Amount; net: Amount; tax: Amount; grand: Amount; cost?: Amount },
  extra: Partial<Pick<DocumentSummaryRow, 'ref' | 'taxRate' | 'einvoiceCode'>> = {},
): DocumentSummaryRow {
  return {
    key,
    count,
    qty: dec(sums.qty),
    net: dec(sums.net),
    tax: dec(sums.tax),
    grand: dec(sums.grand),
    cost: dec(sums.cost),
    ref: extra.ref ?? null,
    taxRate: extra.taxRate ?? null,
    einvoiceCode: extra.einvoiceCode ?? null,
  };
}

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Per-day rows → per-month rows (yyyy-mm): counts and amounts added. */
export function foldMonths(days: DocumentSummaryRow[]): DocumentSummaryRow[] {
  const months = new Map<string, DocumentSummaryRow>();
  for (const d of days) {
    const key = d.key.slice(0, 7);
    const m = months.get(key);
    if (!m) {
      months.set(key, { ...d, key });
      continue;
    }
    m.count += d.count;
    m.qty = m.qty.plus(d.qty);
    m.net = m.net.plus(d.net);
    m.tax = m.tax.plus(d.tax);
    m.grand = m.grand.plus(d.grand);
    m.cost = m.cost.plus(d.cost);
  }
  return [...months.values()];
}

/** Code and names of parties, by id (summary rows). */
export async function partyRefs(db: Db, ids: bigint[]): Promise<Map<string, SummaryRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db.party.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, nameAr: true, nameEn: true },
  });
  return new Map(rows.map((r) => [r.id.toString(), { ...r, id: r.id.toString() }]));
}

/** Code and names of items, by id (summary rows). */
export async function itemRefs(db: Db, ids: bigint[]): Promise<Map<string, SummaryRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db.item.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, nameAr: true, nameEn: true },
  });
  return new Map(rows.map((r) => [r.id.toString(), { ...r, id: r.id.toString() }]));
}

/**
 * Line groups by (tax category, rate) → summary rows keyed `categoryId|rate`,
 * with the category's names and its current e-invoice code (S / Z / O).
 */
export async function taxRows(
  db: Db,
  groups: {
    taxCategoryId: bigint | null;
    taxRate: Amount;
    count: number;
    sums: { qty?: Amount; net: Amount; tax: Amount; grand: Amount; cost?: Amount };
  }[],
): Promise<DocumentSummaryRow[]> {
  const ids = [...new Set(groups.map((g) => g.taxCategoryId).filter((x): x is bigint => x !== null))];
  const cats = ids.length
    ? await db.taxCategory.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, nameAr: true, nameEn: true, einvoiceCode: true },
      })
    : [];
  const byId = new Map(cats.map((c) => [c.id, c]));
  return groups.map((g) => {
    const rate = dec(g.taxRate);
    const cat = g.taxCategoryId !== null ? byId.get(g.taxCategoryId) : undefined;
    return summaryRow(`${g.taxCategoryId ?? ''}|${rate.toString()}`, g.count, g.sums, {
      ref: cat ? { id: cat.id.toString(), code: cat.code, nameAr: cat.nameAr, nameEn: cat.nameEn } : null,
      taxRate: rate,
      einvoiceCode: cat?.einvoiceCode ?? null,
    });
  });
}
