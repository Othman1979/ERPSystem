import { Injectable } from '@nestjs/common';
import { readDocument } from 'jofotara-kit';
import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { SalesInvoicesService } from '../sales/sales-invoices.service.js';
import { SalesReturnsService } from '../sales/sales-returns.service.js';
import { resolveBuyer } from './buyer.js';
import { renderUbl, type TaxCategoryCode, type UblDocument, type UblLine } from './ubl-render.js';

/** The document cannot be sent as it is (missing data). Shown to the user; never sent. */
export class EInvoiceBuildError extends Error {
  override name = 'EInvoiceBuildError';
}

interface Submission {
  documentType: string;
  documentId: bigint;
  documentNo: string;
  uuid: string;
  icv: number;
  companyId: bigint;
  originalSubmission: { documentNo: string; uuid: string; documentId: bigint; requestXml: string | null } | null;
}

const ZERO = new Decimal(0);
const dec = (v: { toString(): string }) => new Decimal(v.toString());
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** S at a rate above 0; a 0% line must say Z (exempt) or O (zero-rated) — manual p.41. */
function categoryOf(code: string | null | undefined, rate: Decimal): TaxCategoryCode {
  const c = code?.trim().toUpperCase();
  if (c === 'S' || c === 'Z' || c === 'O') return c;
  if (rate.gt(0)) return 'S';
  throw new EInvoiceBuildError(
    'A 0% tax category needs its e-invoice code: Z (exempt) or O (zero-rated). Set it in Settings → Taxes',
  );
}

/**
 * Builds the JoFotara XML of a queued document from the POSTED document
 * (never from client data, BUILD_PLAN §12.2), with the amounts exactly as
 * posted (0005 §13). Sales documents are read through the sales services.
 */
@Injectable()
export class EInvoiceDocumentsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly invoices: SalesInvoicesService,
    private readonly returns: SalesReturnsService,
  ) {}

  async buildXml(sub: Submission, conn: { track: 'INCOME' | 'GENERAL_SALES'; incomeSourceSequence: string }) {
    const { db } = this.support.tenant();
    const company = await db.company.findFirst({
      where: { id: sub.companyId },
      select: { taxNumber: true, legalNameAr: true },
    });
    if (!company?.taxNumber) throw new EInvoiceBuildError('The company has no tax number');
    const seller = {
      taxNumber: company.taxNumber,
      name: company.legalNameAr,
      incomeSourceSequence: conn.incomeSourceSequence,
    };
    const doc =
      sub.documentType === 'SALES_RETURN'
        ? await this.returnDocument(sub, seller)
        : await this.invoiceDocument(sub, conn.track, seller);
    if (doc.track === 'INCOME' && doc.lines.some((l) => !l.tax.isZero())) {
      throw new EInvoiceBuildError('An income-track company cannot charge sales tax: the document has tax on a line');
    }
    return renderUbl(doc);
  }

  private async invoiceDocument(
    sub: Submission,
    track: 'INCOME' | 'GENERAL_SALES',
    seller: UblDocument['seller'],
  ): Promise<UblDocument> {
    const inv = await this.invoices.einvoiceSource(sub.documentId);
    if (!inv?.invoiceNo) throw new EInvoiceBuildError('The invoice is not posted');
    const buyer = resolveBuyer(inv.customer, inv.paymentType, inv.grandTotal.toString());
    if (!buyer.ok) throw new EInvoiceBuildError(buyer.reason);
    const lines: UblLine[] = inv.lines.map((l) => {
      const rate = dec(l.taxRate);
      return {
        id: l.lineNo,
        name: l.item.nameAr,
        quantity: dec(l.qty),
        unitPrice: dec(l.unitPrice),
        discount: dec(l.discountAmount),
        extension: dec(l.netAmount),
        category: track === 'INCOME' ? 'Z' : categoryOf(l.taxCategory?.einvoiceCode, rate),
        rate,
        tax: dec(l.taxAmount),
      };
    });
    return {
      kind: 'invoice',
      track,
      paymentTerms: inv.paymentType === 'CREDIT' ? 'receivable' : 'cash',
      id: inv.invoiceNo,
      uuid: sub.uuid,
      issueDate: ymd(inv.invoiceDate),
      icv: sub.icv,
      note: inv.description,
      seller,
      buyer: buyer.buyer,
      lines,
    };
  }

  /**
   * A return mirrors its original as it was sent (p.22-29): the same type
   * name, buyer and line numbers, only the returned quantities. The
   * quantity goes back to the original line's unit; the discount is written
   * as price × quantity − net, so each line adds up exactly (0005 §9).
   */
  private async returnDocument(
    sub: Submission,
    seller: UblDocument['seller'],
  ): Promise<UblDocument> {
    const original = sub.originalSubmission;
    if (!original?.requestXml) throw new EInvoiceBuildError('The original invoice has not been sent yet');
    const ret = await this.returns.einvoiceSource(sub.documentId);
    if (!ret?.returnNo) throw new EInvoiceBuildError('The return is not posted');
    if (!ret.reason?.trim()) throw new EInvoiceBuildError('The return has no reason');
    const originalInvoice = await this.invoices.einvoiceSource(original.documentId);
    if (!originalInvoice) throw new EInvoiceBuildError('The original invoice was not found');
    const sent = readDocument(original.requestXml);
    // Same track as the original was sent on, whatever the setting says now.
    const returnTrack = sent.track === 'income' ? 'INCOME' : 'GENERAL_SALES';

    const lines: UblLine[] = ret.lines.map((l) => {
      const o = l.originalLine;
      const quantity = round6(dec(l.qtyBase).times(dec(o.qty)).div(dec(o.qtyBase)));
      const unitPrice = dec(l.unitPrice);
      const extension = dec(l.netAmount);
      const gross = round3(quantity.times(unitPrice));
      const rate = dec(l.taxRate);
      return {
        id: o.lineNo,
        name: o.item.nameAr,
        quantity,
        unitPrice,
        discount: Decimal.max(gross.minus(extension), ZERO),
        extension,
        category: returnTrack === 'INCOME' ? 'Z' : categoryOf(o.taxCategory?.einvoiceCode, rate),
        rate,
        tax: dec(l.taxAmount),
      };
    });
    return {
      kind: 'credit-note',
      track: returnTrack,
      paymentTerms: sent.paymentTerms === 'receivable' ? 'receivable' : 'cash',
      id: ret.returnNo,
      uuid: sub.uuid,
      issueDate: ymd(ret.returnDate),
      icv: sub.icv,
      seller,
      // The buyer exactly as on the original invoice (p.25, p.47).
      buyer: { scheme: sent.buyer.scheme, id: sent.buyer.id, name: sent.buyer.name, phone: sent.buyer.phone },
      lines,
      billingReference: { id: original.documentNo, uuid: original.uuid, total: dec(originalInvoice.grandTotal) },
      reason: ret.reason,
    };
  }
}
