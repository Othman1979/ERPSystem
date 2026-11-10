# 0005: ربط حقول JoFotara بقاعدة البيانات

**الحالة:** مسودة — Phase 7 (بانتظار موافقة المالك)
**التاريخ:** 2026-11-10
**المرجع:** الدليل التقني لدائرة ضريبة الدخل والمبيعات للربط مع نظام الفوترة الوطني عبر API،
**الإصدار 1.4، المعتمد في 2023-12-01**، كما تلخصه أداة `jofotara-kit` 0.3.0 (MIT) ومهارة `jofotara`.
أرقام الصفحات (p.N) من ذلك الدليل.

> **يجب مطابقة هذا الملف مع الوثيقة الرسمية السارية قبل التشغيل على الإنتاج** (BUILD_PLAN §12).
> لا توجد بيئة SANDBOX حكومية: أي طلب ببيانات اعتماد حقيقية ينشئ سجلاً ضريبياً حقيقياً.

## 1. النطاق

- يُرسل: **فاتورة البيع** (`388`) و**مرتجع البيع** (`381`). فواتير ومرتجعات الشراء لا تُرسل.
- المسار حسب تسجيل الشركة (إعداد جديد `track`):
  - **دخل** `011` نقدي / `021` ذمم — شركة غير مسجلة في ضريبة المبيعات، بلا `TaxTotal`.
  - **مبيعات عامة** `012` نقدي / `022` ذمم — ضريبة عامة لكل سطر وللمستند.
  - **مبيعات خاصة** `013/023` **خارج النطاق** في هذه المرحلة (قرار المالك #4).
- العملة: `JOD` فقط. الشركة التي عملتها الأساسية غير الدينار لا يُفعّل لها الربط.
- المستندات المرحّلة قبل تاريخ التفعيل (`enabled_at`) لا تُرسل.

## 2. الإرسال (p.9, p.81)

| البند | القيمة |
|---|---|
| Endpoint | `POST {base_url}/core/invoices/` |
| الإنتاج | `https://backend.jofotara.gov.jo` |
| SANDBOX | لا توجد بيئة حكومية؛ `SANDBOX` في الإعدادات تعني المحاكي المحلي `jofotara-kit serve` (عنوان قابل للتعديل) |
| الترويسات | `Client-Id`، `Secret-Key` (من شاشة ربط الأجهزة في البوابة، p.7) |
| الجسم | `{"invoice": "<base64 لـ XML بترميز UTF-8>"}` |
| القبول | نجاح HTTP **و**حالة نجاح صريحة **و**وجود QR. نجاح HTTP وحده ليس قبولاً |

## 3. رأس المستند (p.11–12)

| حقل UBL | فاتورة البيع | مرتجع البيع |
|---|---|---|
| `cbc:ProfileID` | ثابت `reporting:1.0` | ثابت |
| `cbc:ID` | `sales_invoices.invoice_no` (يُمنح عند الترحيل، متسلسل بلا فجوات §11) | `sales_returns.return_no` |
| `cbc:UUID` | **جديد** — يُولّد مرة واحدة عند إدراج المستند في الطابور ولا يتغير مع إعادة المحاولة | **جديد** — كذلك |
| `cbc:IssueDate` | `invoice_date` (yyyy-mm-dd) | `return_date` |
| `cbc:InvoiceTypeCode` | `388` | `381` |
| `@name` | `0` + الدفع (`CASH`→1، `CREDIT`→2) + المسار (دخل 1، مبيعات عامة 2) | **نفس اسم الفاتورة الأصلية** (الدفع من `payment_type` للأصلية، لا من `refund_type`) |
| `cbc:Note` | `description` (اختياري) | — |
| `DocumentCurrencyCode` / `TaxCurrencyCode` | ثابت `JOD`؛ وكل مبلغ يحمل `currencyID="JO"` | ثابت |
| ICV (`AdditionalDocumentReference[ID=ICV]/UUID`) | **جديد** — عداد لكل شركة/مصدر دخل `einvoice_settings.next_icv`، يُمنح عند الإدراج في الطابور داخل معاملة الترحيل | **جديد** — من العداد نفسه |

## 4. البائع (p.13, p.16)

| حقل UBL | المصدر |
|---|---|
| `PostalAddress/Country` | ثابت `JO` |
| `PartyTaxScheme/CompanyID` | `companies.tax_number` — **إلزامي** لتفعيل الربط |
| `PartyLegalEntity/RegistrationName` | `companies.legal_name_ar` (الاسم كما هو مسجل لدى الدائرة) |
| `SellerSupplierParty/.../PartyIdentification/ID` (تسلسل مصدر الدخل) | **جديد** `einvoice_settings.income_source_sequence` |

## 5. المشتري (p.14–15, p.35–36)

| حقل UBL | المصدر |
|---|---|
| `PartyIdentification/ID` + `@schemeID` | `TN` ← `parties.tax_number` إن وُجد؛ وإلا `parties.national_id` بمخطط `NIN` (أردني) أو `PN` (غير أردني) — **جديد** `parties.national_id_kind` (`NIN` افتراضياً / `PN`). أرقام فقط |
| المشتري النقدي العابر | `parties.is_cash_customer` بلا رقم ← `TN` `0` واسم "Cash customer" (عُرف شائع، **غير منصوص في الدليل**) |
| `PostalAddress/PostalZone` | لا عمود — اختياري، لا يُرسل |
| `PostalAddress/CountrySubentityCode` | لا عمود (`parties.city` نص حر) — اختياري، لا يُرسل في هذه المرحلة |
| `PartyTaxScheme/CompanyID` (مستندات المبيعات) | نفس رقم المشتري |
| `PartyLegalEntity/RegistrationName` | `parties.name_ar` — **إلزامي** للذمم وللنقدي فوق 10,000 دينار |
| `AccountingContact/Telephone` | `parties.phone` (اختياري) |

المرتجع يأخذ بيانات المشتري من **XML الفاتورة الأصلية المخزّن** كما هو (p.25, p.47)، لا من بطاقة العميل الحالية.

## 6. السطور (p.29, p.39–41)

| حقل UBL | فاتورة البيع (`sales_invoice_lines`) | مرتجع البيع (`sales_return_lines`) |
|---|---|---|
| `cbc:ID` | `line_no` | **`line_no` للسطر الأصلي** (عبر `original_line_id`)، لا ترقيم جديد |
| `InvoicedQuantity@unitCode` | `qty` (بوحدة البيع المختارة)، الرمز ثابت `PCE` كما في نماذج الدليل | `qty_base` ÷ معامل وحدة السطر الأصلي (الكمية بوحدة الفاتورة) |
| `Item/Name` | `items.name_ar` | اسم السطر في XML الأصلي |
| `Price/PriceAmount` | `unit_price` (قبل الضريبة — الحساب الحالي لا يدعم أسعاراً شاملة) | `unit_price` (منسوخ من الأصلي) |
| `Price/BaseQuantity unitCode="C62"` | — | ثابت `1` (مرتجعات المبيعات العامة فقط) |
| `Price/AllowanceCharge/Amount` (`DISCOUNT`) | `discount_amount` | `round3(qty × price) − net_amount` (انظر §9) |
| `LineExtensionAmount` | `net_amount` | `net_amount` |
| `TaxTotal/TaxAmount` | `tax_amount` | `tax_amount` |
| `TaxTotal/RoundingAmount` | `line_total` | `line_total` |
| `TaxSubtotal/TaxableAmount` | — | `net_amount` (مرتجعات المبيعات العامة) |
| `TaxCategory/ID` | `tax_categories.einvoice_code`: `S` / `Z` معفى / `O` صفري | نفسه |
| `TaxCategory/Percent` | `tax_rate`؛ المسموح 0، 1، 2، 3، 4، 5، 7، 8، 10، 16 | نفسه |

مسار **الدخل**: لا `TaxTotal` في السطور ولا في المستند.

## 7. الإجماليات (p.17, p.38)

| حقل UBL | المصدر |
|---|---|
| `AllowanceCharge/Amount` و`AllowanceTotalAmount` | Σ خصم السطور (لا يوجد خصم على مستوى المستند في النظام) |
| `TaxExclusiveAmount` | Σ (`net_amount` + خصم السطر) = Σ السعر × الكمية |
| `TaxTotal/TaxAmount` | `tax_total` (= Σ ضريبة السطور) |
| `TaxTotal/TaxSubtotal` (مرتجعات المبيعات العامة) | واحد لكل (فئة، نسبة): Σ `net_amount` و Σ `tax_amount` |
| `TaxInclusiveAmount` و`PayableAmount` | `grand_total` |
| `PrepaidAmount` | ثابت `0` (مرتجعات المبيعات العامة) |

## 8. المرتجعات (p.21–30, p.43–55)

| حقل UBL | المصدر |
|---|---|
| `BillingReference/InvoiceDocumentReference/ID` | `invoice_no` للفاتورة الأصلية |
| `.../UUID` | UUID المخزّن للفاتورة الأصلية |
| `.../DocumentDescription` | `grand_total` للفاتورة الأصلية |
| `PaymentMeans/PaymentMeansCode listID="UN/ECE 4461"` | ثابت `10` |
| `PaymentMeans/InstructionNote` | `sales_returns.reason` — **إلزامي** عند تفعيل الربط (العمود اليوم اختياري) |

- المرتجع على **الكميات** فقط ولا يتجاوز المباع؛ النظام يتحقق من ذلك اليوم (`sales-returns.service`).
- مرتجعات متعددة مسموحة حتى استنفاد الكميات.
- **لا يُرسل المرتجع إلا بعد قبول فاتورته الأصلية** (§12.2).

## 9. التقريب (قرار المالك #2)

الحساب الحالي (`shared/invoice-math.ts`): **لكل سطر**، 3 منازل، `ROUND_HALF_UP`؛ إجماليات المستند = Σ السطور.
هذا يوافق الدليل (ضريبة لكل سطر، والمستند مجموع السطور). أداة التحقق تقبل فرق تقريب حتى فلس واحد.
**التوصية: اعتماد التقريب لكل سطر كما هو.**

خطر معروف في المرتجعات: الخصم وصافي السطر يُحسبان بالتناسب كلٌ على حدة ويُقرّبان منفصلين، فقد
لا يساوي `السعر × الكمية − الخصم` صافي السطر بفارق فلس. لذلك يُكتب الخصم في XML بقيمة
`round3(qty × price) − net_amount` ليبقى السطر متسقاً تماماً، والمبالغ المرحّلة لا تتغير.

## 10. ما يجب إضافته

| الجدول/العمود | الغرض |
|---|---|
| `einvoice_settings` (لكل شركة) | `environment` (SANDBOX/PRODUCTION)، `base_url`، `client_id`، `secret_encrypted` (AES-256-GCM بمفتاح `EINVOICE_ENC_KEY`)، `income_source_sequence`، `track` (INCOME/GENERAL_SALES)، `next_icv`، `is_enabled`، `enabled_at` |
| `einvoice_submissions` (BUILD_PLAN §7.9) | لكل مستند: النوع، المعرّف، الرقم، UUID، ICV، XML المرسل (بلا أسرار)، الحالة، QR، الاستجابة الخام، المحاولات |
| `parties.national_id_kind` | `NIN` / `PN` |
| تقييد `tax_categories.einvoice_code` | `S` / `Z` / `O` فقط، و`S` بنسبة من القائمة المسموحة |

الحقول الموجودة التي تكفي دون تعديل: `invoice_no`، التواريخ، `payment_type`، كل مبالغ السطور
والإجماليات، `original_invoice_id`، `original_line_id`، `tax_rate`، `companies.tax_number`،
`companies.legal_name_ar`، `parties.tax_number`، `parties.national_id`، `parties.name_ar`، `parties.phone`.

## 11. قرارات معلقة للمالك

1. **#2 التقريب:** لكل سطر (التوصية، وهو الحالي) أم للمستند.
2. **#3 حقول العميل الإلزامية:** التوصية — لفواتير الذمم وللنقدي فوق 10,000 دينار: الاسم ورقم
   (ضريبي أو وطني أو شخصي) إلزامي، ويُرفض الترحيل بدونه عند تفعيل الربط؛ النقدي تحت الحد بلا رقم
   يُرسل كمشترٍ عابر `TN 0`. المدينة غير إلزامية.
3. **#4 الضريبة الخاصة:** خارج النطاق الآن (013/023 لم تُختبر على النظام الحي حسب أداة التحقق).
4. **مسار الشركة:** دخل أم مبيعات عامة (إعداد لكل شركة؛ يدعم الاثنين).

## 12. غير مغطى في الدليل

- صيغة رسائل الخطأ ورموزها.
- معرّف المشتري المجهول (`TN 0` عُرف يُتحقق منه بمستند حقيقي منخفض القيمة).
- أطوال الحقول القصوى.
- هل يجب أن يصل ICV بالترتيب (المرتجع ينتظر قبول أصليته فقد يُرسل بعد مستندات أحدث منه).
- بيئة اختبار — لا توجد.

## 13. التصميم المعتمد (Phase 7، بموافقة المالك 2026-11-10)

**الأداة:** `jofotara-kit` (MIT) تبعية للـ API: `validate()` قبل كل إرسال، و`createClient().submit()`
لتصنيف الرد (accepted / rejected / unknown / not-sent)، و`createMockServer()` في الاختبارات.
الـ XML يكتبه النظام بنفسه (`einvoice/ubl-render.ts`، منقول من `render.js` في الأداة) من
**المبالغ المرحّلة كما هي** (3 منازل)، فالفاتورة المطبوعة والمرسلة متطابقتان بالفلس. يتطلب Node ≥ 22.18.

**الجداول:**
- `einvoice_settings` (واحد لكل شركة) — الحقول في §10؛ `next_icv` يُقفل `FOR UPDATE` عند الإدراج.
- `einvoice_submissions` (واحد لكل مستند): `document_type` (SALES_INVOICE / SALES_RETURN)،
  `document_id`، `document_no`، `uuid`، `icv`، `environment`، `status`، `attempt_count`،
  `next_attempt_at`، `claimed_at`، `request_xml`، `response_code`، `response_body`، `errors`،
  `qr_payload`، `government_uuid`، `original_submission_id` (للمرتجع)، `sent_at`، `completed_at`.
  فريد على (tenant, document_type, document_id) وعلى (tenant, company, icv).
- `einvoice_attempts`: سجل كل محاولة (رقمها، وقتها، حالة HTTP، النتيجة، الرد الخام).

**التدفق:**
1. ترحيل فاتورة البيع، إن كان الربط مفعلاً: تحقق المشتري (§11 القرار 2) **قبل** الترحيل، ثم
   داخل نفس المعاملة: UUID جديد + ICV من العداد + صف `PENDING`. لا اتصال خارجي داخل المعاملة.
2. ترحيل مرتجع البيع: السبب إلزامي؛ يُدرج فقط إن كان لفاتورته الأصلية صف إرسال.
3. مهمة كل دقيقة (`setInterval` داخل الـ API، تُعطَّل بـ `EINVOICE_WORKER=off`): تحجز الصفوف بـ
   `UPDATE … SET status='SENDING', claimed_at=NOW(), claim_token=? WHERE status='PENDING' AND
   next_attempt_at <= NOW() LIMIT n` (يعمل على MariaDB 10.4 بلا SKIP LOCKED)، ثم لكل صف داخل
   سياق مستأجره: يبني الـ XML من المستند المرحّل، يتحقق، يرسل.
4. النتيجة:
   - **accepted** → `ACCEPTED`، يُحفظ QR وUUID الحكومي والرد الخام.
   - **rejected** أو فشل التحقق المحلي → `REJECTED` مع الأخطاء؛ لا إعادة تلقائية. "إعادة الإرسال"
     اليدوية تعيد البناء بنفس UUID وICV بعد تصحيح البيانات.
   - **not-sent / unreachable** (لم يصل الطلب) → `FAILED`، إعادة تلقائية بتأخير متزايد، 5 محاولات حداً أقصى.
   - **unknown** (مهلة، رد غير مقروء، 5xx بلا دليل) → `UNKNOWN`؛ لا إعادة تلقائية. الإجراء اليدوي
     الوحيد: إعادة إرسال **نفس الـ XML** بعد التحقق من البوابة. (أكثر تحفظاً من "5xx → FAILED" في
     BUILD_PLAN §12.2: الطلب ربما سُجّل.)
   - صف بقي `SENDING` أكثر من 10 دقائق (توقف أثناء الإرسال) → `UNKNOWN`.
5. المرتجع ينتظر `ACCEPTED` لفاتورته الأصلية؛ يبقى `PENDING` ويُعاد فحصه.

**الأمان:** السر يُشفَّر بـ AES-256-GCM (`EINVOICE_ENC_KEY`، 32 بايت base64)، لا يُعاد في أي رد
(الـ API يعيد `hasSecret` فقط)، لا يُسجّل في سجل التدقيق ولا في `request_xml`. الانتقال إلى
PRODUCTION يتطلب صلاحية `einvoice.manage` ودور المالك.

**الواجهة:** تبويب "الفوترة الإلكترونية" في الإعدادات؛ شاشة متابعة الإرسال (الحالة، المحاولات،
الأخطاء، إعادة الإرسال)؛ حالة الفاتورة وQR في عرضها وطباعتها، وعلامة واضحة إن لم تُقبل بعد؛
نوع الرقم الوطني (NIN/PN) في بطاقة الطرف.
