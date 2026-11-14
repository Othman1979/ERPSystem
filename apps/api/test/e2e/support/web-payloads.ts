/**
 * The web app's own request-body builders, loaded from apps/web/src, so the
 * e2e suites send exactly what the pages send (PLAT-15 review): a form bug
 * that a hand-built body would hide fails here too.
 *
 * Loaded by a computed path: jest transforms them like any test file, while
 * `tsc` for the API does not follow it into the web package. The signatures
 * below are the builders' own, narrowed to what the tests use; the web's
 * typecheck holds the builders to the generated request DTOs.
 */
import path from 'node:path';

const WEB_SRC = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'web', 'src');

type Body = Record<string, unknown>;

export interface WebPayloads {
  itemUpdateBody(values: Body): Body;
  itemCreateBody(values: Body): Body;
  partyUpdateBody(values: Body): Body;
  partyCreateBody(values: Body): Body;
  purchaseReturnBody(
    invoice: { id: string; warehouseId: string | null; lines: { id: string }[] },
    form: { returnDate: string; refundType: 'CASH' | 'CREDIT'; cashAccountId?: string; reason?: string; qtyByLine: Record<string, string> },
  ): Body;
}

const load = async (file: string) => (await import(path.join(WEB_SRC, file))) as Record<string, unknown>;

export async function webPayloads(): Promise<WebPayloads> {
  const [items, parties, returns] = await Promise.all([
    load('pages/items/itemPayload.ts'),
    load('pages/parties/partyPayload.ts'),
    load('pages/purchases/returnPayload.ts'),
  ]);
  return { ...items, ...parties, ...returns } as unknown as WebPayloads;
}
