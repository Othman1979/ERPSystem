# تقرير المرحلة 4 — المخزون

**التاريخ:** 2026-11-08
**الحالة:** مكتملة ومتحقق منها

## النطاق المنجز

### قاعدة البيانات
- 15 نموذجاً جديداً (tenant-scoped، مفاتيح مركبة `[tenantId, id]`):
  - `item_groups` — مجموعات أصناف شجرية
  - `items` — أصناف `STOCK|SERVICE`، وحدة أساس، مجموعة، فئة ضريبية، أسعار بيع/شراء، حد طلب أدنى
  - `item_units` — وحدات بديلة مع `factor_to_base` وأعلام افتراضي بيع/شراء
  - `item_barcodes` — باركود فريد لكل مستأجر (ربط اختياري بوحدة صنف)
  - `warehouses` — ربط بشركة وفرع اختياري
  - `stock_movements` — دفتر حركات غير قابل للتعديل: وارد/صادر، مصدر (`source_type`/`source_id`/`source_line_id`)، تكلفة الوحدة والإجمالي، رصيد وتكلفة متوسطة بعد الحركة، ربط عكسي
  - `stock_balances` — إسقاط كمية الرصيد لكل (مستودع، صنف)
  - `item_costs` — متوسط التكلفة المرجّح لكل (شركة، صنف)
  - `stock_adjustments` + lines — OPENING/IN/OUT/COUNT_ADJUSTMENT مع ربط قيد يومية
  - `stock_transfers` + lines — تحويل بين مستودعين
  - `stock_counts` + lines — جرد فعلي (system vs counted)
- enums: `ItemKind`, `StockMovementType`, `StockAdjustmentType`, `DocumentStatus`
- الترحيل: `20261108184703_phase4_inventory` (مُطبّق على `erp_dev` و`erp_test`)
- كل النماذج في `TENANT_MODELS` → عزل تلقائي.

### محرك المخزون (`stock-ledger.service.ts`)
- **النقطة الوحيدة** لإنشاء الحركات وتحديث الإسقاطات — كل العمليات داخل معاملة المستدعي.
- قفل `SELECT … FOR UPDATE` على `item_costs` ثم `stock_balances` بترتيب ثابت لمنع التعارضات.
- **متوسط التكلفة المرجّح** (§9.2): الوارد يعيد حساب المتوسط؛ الصادر يخرج بمتوسط التكلفة الحالي؛ تفريغ الصنف يصفّر القيمة residual.
- **منع الرصيد السالب** حسب `company.allow_negative_stock` → `STOCK_INSUFFICIENT` (409).
- **منع الترحيل الرجعي**: لا حركة قبل آخر `movement_date` للصنف → `BACKDATED_STOCK_POSTING` (409).
- رفض الحركات على أصناف `SERVICE`.
- `verify()` — إعادة حساب الأرصدة من الحركات ومقارنتها بالإسقاطات (`GET /stock/verify`).

### المستندات
- **التسويات** (`adjustments.service.ts`): مسودة → ترحيل في معاملة واحدة: حركات + قيد يومية متوازن + رقم مستند `SA-YYYY-…`. OPENING يقيد `Dr INVENTORY / Cr OPENING_BALANCE_EQUITY`؛ IN/OUT وCOUNT_ADJUSTMENT تقيد `INVENTORY ↔ INVENTORY_ADJUSTMENT`. العكس ينشئ حركات معاكسة بنفس التكلفة الأصلية وقيد `REVERSAL`.
- **التحويلات** (`transfers.service.ts`): صادر من المصدر + وارد للوجهة **بنفس متوسط التكلفة** — لا تغيير في `item_costs` ولا قيد يومية. العكس يعيد الكميات.
- **الجرد** (`counts.service.ts`): لقطة `system_qty` عند الإنشاء، إدخال `counted_qty` لكل سطر، الاعتماد يولّد مستند `COUNT_ADJUSTMENT` ويُرحّله عبر نفس مسار التسويات.
- كل الترحيلاتthrough `PostingService` (تحقق حسابات/فترات/ترقيم `JV`/`ST`/`SA` gapless).
- إعادة محاولة تلقائية على deadlock/lock-timeout.

### حدود الباقة
- `PlanLimitsService.assertWarehouseSlotAvailable()` — حد `maxWarehouses` حسب الباقة (TRIAL=1, BASIC=2, PRO=10).

### الواجهة
- `ItemsPage` — تبويبا الأصناف (بحث/فلتر نوع/إضافة/تعديل/إلغاء تفعيل) ومجموعات الأصناف (شجرية).
- `WarehousesPage` — CRUD كامل مع ربط الفرع.
- `StockPage` — 6 تبويبات: الأرصدة (فلتر مستودع/تحت حد الطلب)، التسويات (إنشاء بخطوط ديناميكية + ترحيل/عكس/حذف)، التحويلات، الجرد (إدخال الكميات + اعتماد)، حركات المخزون، التقييم (بمتوسط التكلفة).
- **إصلاح واجهة**: `JournalPage` كان يستدعي `/post` و`/reverse` بدون `Idempotency-Key` → 400 دائماً. أُضيف `src/idempotency.ts` وتُمرَّر الترويسة في كل استدعاءات الترحيل/العكس (القيود + مستندات المخزون).
- مفاتيح ترجمة ar/en كاملة.

## نقاط API جديدة (24 مساراً)
`/item-groups`, `/items` (+`/items/:id/units`, `/items/:id/barcodes`, `/items/barcode/:code`, `/item-barcodes/:id`), `/warehouses`, `/stock-adjustments` (+`/:id/post|reverse`), `/stock-transfers` (+`/:id/post|reverse`), `/stock-counts` (+`/:id/lines/:lineId`, `/:id/approve`), `/stock/balances|movements|valuation|verify`.

## الأخطاء المُصلحة أثناء العمل
- **`COUNT_ADJUSTMENT` في العكس**: كان يختار حقل الكمية الصفري (`qtyOut` بدل `qtyIn`) → رُفض بـ qty=0. صُحّح.
- **رقم المستند**: كان يُستخدم رقم `SA` نفسه كـ `entry_no` للقيد؛ فُصل إلى `STOCK_ADJUSTMENT` للمستند و`JOURNAL_ENTRY` للقيد.
- **قيد فارغ**: تسوية/جرد بتكلفة صفرية كانت ستفشل في `postEntry` (أقل سطرين) → يُتخطّى القيد ويُحفظ `journal_entry_id = null`.
- **`isActive` في قائمة الأصناف**: الفلتر `!== undefined` كان يحوّل '' إلى `false` → صُحّح لفحص truthy.
- **`accountId: { not: null }`** غير مدعوم في Prisma 7 → فلترة في JS.
- **حد المستودعات في الاختبار**: TRIAL=1 → أُدرج المستودع الثاني مباشرة في DB داخل الاختبار.

## التحقق
- `pnpm --filter api typecheck` + `lint` + `build` ✓
- `pnpm --filter web typecheck` + `lint` + `build` ✓
- **51 اختبار API أخضر** (7 مجموعات) — منها 10 اختبارات phase4 جديدة على `erp_test`: OPENING+قيد، متوسط مرجّح (10@5 + 10@7 → 6، صادر 5 → تكلفة 30)، `STOCK_INSUFFICIENT`، رفض أصناف الخدمة، `BACKDATED_STOCK_POSTING`، تحويل بنفس التكلفة بدون قيد، عكس تحويل، جرد→COUNT_ADJUSTMENT، `stock:verify` نظيف، عزل مستأجرين.
- api-client أُعيد توليده (69 مساراً).

## إضافة لاحقة (2026-11-08) — مواءمة دليل فواتير للأصناف

استناداً إلى دليل أصناف منصة فواتير (fawatear.com/guide/inventory/items.html):
- `units.un_ece_code` — رموز UN/ECE Rec.20 (PCE/BX/DOZ/KGM/GRM/LTR/MTR) للوحدات الافتراضية، قابلة للتحرير من الإعدادات — مطلوبة لفوترة JoFotara.
- حقول صنف جديدة: `max_stock`، `default_warehouse_id`، `sale_price_includes_tax`، `image_url`، وربط `tax_category_id` من الواجهة.
- `GET /stock/items/:itemId/ledger` — كشف حركة الصنف: حركات تصاعدية مع الرصيد التراكمي ومتوسط التكلفة بعد كل حركة + إجماليات الأرصدة الحالية.
- واجهة الأصناف: عرض بطاقات/جدول مع شارة مستوى المخزون (أخضر/برتقالي/أحمر)، نافذة كشف الحركة بفلاتر (مستودع/فترة)، وطباعة ملصقات باركود (JsBarcode + طباعة حرارية).
