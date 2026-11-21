import { randomUUID } from 'node:crypto';
import request from 'supertest';

export type LockDocType =
  | 'JOURNAL_ENTRY'
  | 'RECEIPT'
  | 'PAYMENT'
  | 'SALES_INVOICE'
  | 'PURCHASE_INVOICE';

export async function withDocumentEditLock<T>(
  base: string,
  token: string,
  docType: LockDocType,
  id: string,
  action: (holderToken: string) => Promise<T>,
): Promise<T> {
  const holderToken = randomUUID();
  const headers = { Authorization: `Bearer ${token}`, 'X-Edit-Lock': holderToken };
  const acquired = await request(base)
    .post(`/api/v1/document-locks/${docType}/${id}/acquire`)
    .set(headers);
  if (acquired.status !== 201) {
    throw new Error(`acquire ${docType} ${id} → ${acquired.status} ${JSON.stringify(acquired.body)}`);
  }
  try {
    return await action(holderToken);
  } finally {
    await request(base)
      .delete(`/api/v1/document-locks/${docType}/${id}`)
      .set(headers);
  }
}
