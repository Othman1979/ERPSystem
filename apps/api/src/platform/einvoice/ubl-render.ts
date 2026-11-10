/**
 * JoFotara UBL 2.1 XML for sales invoices (388) and sales returns (381),
 * written from the POSTED amounts as they are (docs/decisions/0005 §13), so
 * the printed and the submitted documents match to the fils.
 *
 * The element layout follows `renderDocument` in jofotara-kit 0.3.0
 * (MIT, https://github.com/balwahidi/jofotara-kit), which models the ISTD
 * technical guide v1.4; every document is checked with that kit's
 * `validate()` before it is sent. Special sales (013/023) are out of scope.
 */
import { Decimal } from '../../common/decimal/decimal.utils.js';

export type EInvoiceTrackCode = 'INCOME' | 'GENERAL_SALES';
export type TaxCategoryCode = 'S' | 'Z' | 'O';
export type BuyerScheme = 'NIN' | 'PN' | 'TN';

export interface UblLine {
  /** Line number; on a return, the ORIGINAL invoice line number (p.29). */
  id: number;
  name: string;
  /** In the invoice line's unit. */
  quantity: Decimal;
  /** Before tax. */
  unitPrice: Decimal;
  discount: Decimal;
  /** quantity × unit price − discount (the posted net amount). */
  extension: Decimal;
  category: TaxCategoryCode;
  /** Percent, e.g. 16. */
  rate: Decimal;
  tax: Decimal;
}

export interface UblDocument {
  kind: 'invoice' | 'credit-note';
  track: EInvoiceTrackCode;
  paymentTerms: 'cash' | 'receivable';
  id: string;
  uuid: string;
  /** yyyy-mm-dd */
  issueDate: string;
  icv: number;
  note?: string | null;
  seller: { taxNumber: string; name: string; incomeSourceSequence: string };
  buyer: { scheme: BuyerScheme; id: string; name?: string | null; phone?: string | null };
  lines: UblLine[];
  /** Returns: the original invoice (p.23). */
  billingReference?: { id: string; uuid: string; total: Decimal };
  /** Returns: PaymentMeans/InstructionNote (p.26). */
  reason?: string | null;
}

export interface UblTotals {
  /** Σ quantity × unit price. */
  taxExclusive: Decimal;
  allowance: Decimal;
  tax: Decimal;
  taxInclusive: Decimal;
  payable: Decimal;
}

const ZERO = new Decimal(0);
const sum = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), ZERO);

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Money as posted: three decimals (the manual fixes no decimal count). */
const money = (v: Decimal) => v.toFixed(3);
const jo = (tag: string, v: Decimal) => `<cbc:${tag} currencyID="JO">${money(v)}</cbc:${tag}>`;
/** 0 + payment (1 cash, 2 receivable) + track (1 income, 2 general sales), p.9. */
export const typeName = (d: Pick<UblDocument, 'track' | 'paymentTerms'>) =>
  `0${d.paymentTerms === 'receivable' ? 2 : 1}${d.track === 'INCOME' ? 1 : 2}`;

export function totalsOf(lines: UblLine[]): UblTotals {
  const allowance = sum(lines.map((l) => l.discount));
  const extension = sum(lines.map((l) => l.extension));
  const tax = sum(lines.map((l) => l.tax));
  const taxInclusive = extension.plus(tax);
  return { taxExclusive: extension.plus(allowance), allowance, tax, taxInclusive, payable: taxInclusive };
}

function category(id: TaxCategoryCode, percent: Decimal) {
  return `<cac:TaxCategory>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${id}</cbc:ID>
          <cbc:Percent>${percent.toString()}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>`;
}

function renderLine(l: UblLine, doc: UblDocument, salesReturn: boolean) {
  const taxed = doc.track !== 'INCOME';
  // General-sales returns carry TaxableAmount on each line (p.52-53).
  const taxable = salesReturn ? `\n        ${jo('TaxableAmount', l.extension)}` : '';
  const taxTotal = taxed
    ? `
    <cac:TaxTotal>
      ${jo('TaxAmount', l.tax)}
      ${jo('RoundingAmount', l.extension.plus(l.tax))}
      <cac:TaxSubtotal>${taxable}
        ${jo('TaxAmount', l.tax)}
        ${category(l.category, l.rate)}
      </cac:TaxSubtotal>
    </cac:TaxTotal>`
    : '';
  return `
  <cac:InvoiceLine>
    <cbc:ID>${l.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${l.quantity.toFixed(6)}</cbc:InvoicedQuantity>
    ${jo('LineExtensionAmount', l.extension)}${taxTotal}
    <cac:Item>
      <cbc:Name>${esc(l.name)}</cbc:Name>
    </cac:Item>
    <cac:Price>
      ${jo('PriceAmount', l.unitPrice)}${salesReturn ? '\n      <cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>' : ''}
      <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>
        ${jo('Amount', l.discount)}
      </cac:AllowanceCharge>
    </cac:Price>
  </cac:InvoiceLine>`;
}

function renderBuyer(b: UblDocument['buyer'], taxed: boolean) {
  return `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${b.scheme}">${esc(b.id)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>JO</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>${taxed ? `\n        <cbc:CompanyID>${esc(b.id)}</cbc:CompanyID>` : ''}
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>${
        b.name
          ? `
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(b.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>`
          : ''
      }
    </cac:Party>${
      b.phone
        ? `
    <cac:AccountingContact>
      <cbc:Telephone>${esc(b.phone)}</cbc:Telephone>
    </cac:AccountingContact>`
        : ''
    }
  </cac:AccountingCustomerParty>`;
}

/** One document-level TaxSubtotal per category and rate (general-sales returns, p.49-50). */
function documentSubtotals(lines: UblLine[]) {
  const groups = new Map<string, { category: TaxCategoryCode; rate: Decimal; taxable: Decimal; tax: Decimal }>();
  for (const l of lines) {
    const key = `${l.category}:${l.rate.toString()}`;
    const g = groups.get(key) ?? { category: l.category, rate: l.rate, taxable: ZERO, tax: ZERO };
    g.taxable = g.taxable.plus(l.extension);
    g.tax = g.tax.plus(l.tax);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(
      (g) => `
    <cac:TaxSubtotal>
      ${jo('TaxableAmount', g.taxable)}
      ${jo('TaxAmount', g.tax)}
      ${category(g.category, g.rate)}
    </cac:TaxSubtotal>`,
    )
    .join('');
}

/** The JoFotara request body: `{"invoice": "<base64 of the UTF-8 XML>"}` (p.81). */
export const toRequestBody = (xml: string) => JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') });

export function renderUbl(doc: UblDocument): string {
  const taxed = doc.track !== 'INCOME';
  const credit = doc.kind === 'credit-note';
  const salesReturn = credit && taxed;
  const t = totalsOf(doc.lines);
  const ref = doc.billingReference;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(doc.id)}</cbc:ID>
  <cbc:UUID>${esc(doc.uuid)}</cbc:UUID>
  <cbc:IssueDate>${esc(doc.issueDate)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="${typeName(doc)}">${credit ? '381' : '388'}</cbc:InvoiceTypeCode>${
    doc.note ? `\n  <cbc:Note>${esc(doc.note)}</cbc:Note>` : ''
  }
  <cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>${
    ref
      ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(ref.id)}</cbc:ID>
      <cbc:UUID>${esc(ref.uuid)}</cbc:UUID>
      <cbc:DocumentDescription>${money(ref.total)}</cbc:DocumentDescription>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`
      : ''
  }
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${doc.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>JO</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(doc.seller.taxNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(doc.seller.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>${renderBuyer(doc.buyer, taxed)}
  <cac:SellerSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID>${esc(doc.seller.incomeSourceSequence)}</cbc:ID>
      </cac:PartyIdentification>
    </cac:Party>
  </cac:SellerSupplierParty>${
    credit
      ? `
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${esc(doc.reason ?? '')}</cbc:InstructionNote>
  </cac:PaymentMeans>`
      : ''
  }
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    ${jo('Amount', t.allowance)}
  </cac:AllowanceCharge>${
    taxed
      ? `
  <cac:TaxTotal>
    ${jo('TaxAmount', t.tax)}${salesReturn ? documentSubtotals(doc.lines) : ''}
  </cac:TaxTotal>`
      : ''
  }
  <cac:LegalMonetaryTotal>
    ${jo('TaxExclusiveAmount', t.taxExclusive)}
    ${jo('TaxInclusiveAmount', t.taxInclusive)}
    ${jo('AllowanceTotalAmount', t.allowance)}${salesReturn ? `\n    ${jo('PrepaidAmount', ZERO)}` : ''}
    ${jo('PayableAmount', t.payable)}
  </cac:LegalMonetaryTotal>${doc.lines.map((l) => renderLine(l, doc, salesReturn)).join('')}
</Invoice>
`;
}
