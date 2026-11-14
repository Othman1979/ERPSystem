# مراجعة قاعدة البيانات — review-database

التاريخ: 2026-11-13. النطاق: `apps/api/prisma/schema.prisma` (61 نموذجاً)، و`migrations/*`، والاستعلامات في `apps/api/src`، وخوارزميات الترحيل والتكلفة والتقارير.
الفرع `main` عند `b987e0d`. قاعدة التطوير `erp_dev` على MariaDB **10.4.32** (XAMPP)، بعزل `REPEATABLE-READ`، و`innodb_buffer_pool_size` بحجم 16MB.

> **تنبيه بيئي:** امتلأ القرص C: (صفر ميغابايت متاحة) أثناء المراجعة. بيانات MariaDB على C:، فأوقفتُ مولّد البيانات قبل أن يرحّل أي مستند (مستأجري 17 فيه مسودات فقط). لذلك **لم يتم اختبار الحجم و EXPLAIN على 50 ألف صف**. خطة الفهارس أدناه مبنية على قراءة الاستعلامات و`SHOW INDEX` الفعلي، ولم تُقَس على حجم حقيقي. السكربتات جاهزة لإعادة التشغيل (القسم 5).

---

## 1. النطاق الذي غطيته

| البند | الطريقة | النتيجة |
|---|---|---|
| المخطط: 61 نموذجاً و19 migration | قراءة كاملة لـ `schema.prisma` | تمت؛ الملاحظات في القسمين 2 و6 |
| الفهارس الفعلية | `information_schema.statistics` على `erp_dev` | تمت. فهارس FK الضمنية `(tenant_id, x_id)` موجودة فعلاً على كل العلاقات المركبة |
| قواعد الحذف في FK | `information_schema.referential_constraints` | 68 CASCADE، 115 RESTRICT، 5 SET NULL |
| أنواع DECIMAL | `information_schema.columns` | تمت؛ انحراف `unit_cost` (DB-06) |
| الترميز والترتيب | الجداول والقاعدة | الأعمدة `utf8mb4_unicode_ci`، والقاعدة الافتراضية `utf8mb4_general_ci` (DB-18) |
| `tenant_id` على كل جدول مستأجر وFK إلى `tenants` | استعلام على `key_column_usage` | 5 جداول بلا FK مباشر (مقبول، DB-21) |
| فحص اليتامى والتوازن (عدّ فقط عبر كل المستأجرين، دون قراءة محتوى) | `orphans.sql` | 0 يتامى؛ 0 قيود غير متوازنة؛ `item_costs` مطابق للحركات؛ **3 حركات فيها `round3(qty×unit_cost) ≠ total_cost`** (DB-06) |
| كل `$queryRaw` / `$executeRaw` | grep وقراءة (وكيل Sonnet، وتحققتُ من العينات) | كلها فيها `tenant_id` ما عدا عامل outbox الفوترة (مقصود وموثق) |
| مطابقة الاستعلامات الساخنة بالفهارس | قراءة الكود و`SHOW INDEX` | القسم 4 |
| EXPLAIN بحجم حقيقي | مولّد عبر API خاص على 3414 | **لم يتم** (القرص ممتلئ)؛ القسم 5 |
| المتوسط المرجح وقاعدة التاريخ السابق | `stock-ledger.service.ts` | DB-03، DB-04، DB-05، DB-19 |
| ترتيب الأقفال وخطر deadlock | كل مستدعي `applyMovement` (12 موضعاً) | DB-02 |
| ترقيم المستندات | `posting.service.ts:310-355` | بلا فجوات؛ تسلسل `JOURNAL_ENTRY` يسلسل ترحيلات المستأجر (DB-08) |
| العزل و`innodb_snapshot_isolation` | `prisma.service.ts` وكود المحوّل | صحيح. تحققتُ أن `PrismaMariaDb` يستخدم الـ pool الممرَّر (`isPool` في `adapter-mariadb/dist/index.mjs:437`)، فيُنفَّذ `initSql` على كل اتصال |
| مهلة المعاملات وإعادة المحاولة | grep لكل `$transaction` | DB-01 |
| حجم الـ pool | `prisma.service.ts:26` | DB-07 |
| N+1 | الترحيل والتقارير | DB-09 |
| تجميع التقارير | `reports.service.ts`، `treasury-reports.service.ts`، `stock-reports.service.ts` | ميزان المراجعة والأرصدة الافتتاحية `groupBy` في SQL (جيد)؛ دفتر الأستاذ وكشف الطرف والأعمار بلا حدود (DB-14) |
| `stock:verify` | `stock-ledger.service.ts:294-349` | DB-11 |
| حذف المستأجر | `tenant-purge.service.ts:116-136` | يعطّل FK مؤقتاً ويحذف جدولاً جدولاً. سليم، لأن سلاسل CASCADE لا تكفي وحدها: `journal_lines→tenants` و`accounts→companies` من نوع RESTRICT |
| نسخة MariaDB | dev وCI والخطة | DB-13 |

---

## 2. جدول النتائج

الخطورة: critical / high / medium / low. الجهد: S (أقل من يوم)، M (يوم إلى ثلاثة)، L (أكثر).

| id | الخطورة | العنوان | الدليل | الأثر | الإصلاح المقترح | الجهد | الملفات |
|---|---|---|---|---|---|---|---|
| DB-01 | high | لا مهلة لأي معاملة ترحيل، فتسري مهلة Prisma الافتراضية (5 ث، و2 ث للانتظار) | 50 استدعاءً لـ `$transaction` ولا يمرّر أيٌّ منها `timeout` غير `jobs/tenant-purge.service.ts:135`. الخطة §10.1 و§10.2 تطلب `timeout: 30000, maxWait: 5000`. أما `withRetry` في `shared/document-support.service.ts:73-81` فيعيد المحاولة فقط عند `P2034` أو deadlock، لا عند `P2028` | فاتورة بـ 40-100 سطر (نحو 9 استعلامات لكل سطر، DB-09) على استضافة بطيئة، أو تحت انتظار قفل، تتجاوز 5 ث فتفشل بـ 500 "Transaction already closed" | ضبطها مركزياً في `new PrismaClient({ adapter, transactionOptions: { timeout: 30000, maxWait: 5000 } })`، وإضافة `P2028` إلى منطق إعادة المحاولة بحذر (فقط إذا لم يُنفَّذ COMMIT) | S | `apps/api/src/prisma/prisma.service.ts`، `apps/api/src/platform/shared/document-support.service.ts` |
| DB-02 | high | ترتيب الأقفال غير ثابت في معظم مسارات المخزون | `applyMovement` يقفل `item_costs` ثم `stock_balances` لكل سطر (`stock-ledger.service.ts:97-100`). وحده التحويل يرتّب الأسطر (`transfers.service.ts:211,318`). المبيعات (`sales-invoices.service.ts:519-537`) والمشتريات (`purchase-invoices.service.ts:471`) والمرتجعات (`sales-returns.service.ts:410`، `purchase-returns.service.ts:348`) والتسويات (`adjustments.service.ts:237,407`) والأذون (`goods-notes.service.ts:237`) تقفل بترتيب الأسطر | مستندان فيهما الصنفان X وY بترتيب معاكس يصلان إلى deadlock. تعيد `withRetry` المحاولة مرة واحدة، فإن تكرر يصل الخطأ إلى المستخدم. هذا يخالف §10.1 الخطوة 12 واختبار §10.4 الثالث. (لم يُعَد إنتاجه بسبب القرص.) | دالة `applyMovements(tx, companyId, inputs[])` في `StockLedgerService` تفرز حسب `(itemId, warehouseId)`، وتقفل كل صفوف `item_costs` باستعلام واحد `WHERE item_id IN (...) ORDER BY item_id FOR UPDATE`، ثم `stock_balances` بالترتيب نفسه، وتعيد النتائج بترتيب الأسطر الأصلي. وكل المستدعين يمرّون بها | M | `stock-ledger.service.ts` + المستدعون الستة أعلاه |
| DB-03 | high | سباق عند أول حركة لصنف: `findFirst` ثم `create` ثم `FOR UPDATE` | `stock-ledger.service.ts:241-249` (التكلفة) و`:279-285` (الرصيد). قراءة `findFirst` غير قافلة | ترحيلان متزامنان لأول مرة على صنف جديد (أو على مستودع جديد) يُدرجان الصف نفسه، فيتلقى الثاني `P2002` أو deadlock إدراج، ولا يُعاد المحاولة → 500. (مقروء في الكود ولم يُعَد إنتاجه) | `INSERT INTO item_costs (...) VALUES (...) ON DUPLICATE KEY UPDATE id = id` ثم `FOR UPDATE`. أو إنشاء صف `item_costs` مع الصنف وصف `stock_balances` عند أول استخدام خارج معاملة الترحيل | S | `stock-ledger.service.ts` |
| DB-04 | high | عكس التحويل المخزني يغيّر قيمة المخزون دون قيد | `transfers.service.ts:288-291` يقرأ `unit_cost` الأصلي المخزّن بثلاث خانات، ثم `:321-340`: خروج من الوجهة **بالمتوسط الحالي** ودخول إلى المصدر **بالتكلفة الأصلية المقرّبة**. والتحويل لا ينشئ قيداً (`transfers.service.ts:24`) | `item_costs.total_value` يتغير بالفرق `round3(q×u_orig) − round3(q×avg_now)` دون أي قيد، فيفترق رصيد حساب المخزون في الأستاذ عن تقييم المخزون. مثال: 1000 وحدة بمتوسط 1.234567 → المخزّن 1.235 → فرق 0.433 حتى دون تغير المتوسط. ويكبر الفرق إذا تغير المتوسط بين التحويل وعكسه. يخالف §9.2 (التحويل لا يغيّر `item_costs`) | استعمال التكلفة نفسها في الطرفين: `unitCost: out.unitCost` (المتوسط الحالي كاملاً) للدخول، كما في الترحيل الأصلي | S | `apps/api/src/platform/inventory/transfers.service.ts` |
| DB-05 | high | عكس تسوية دخول (بما فيها الرصيد الافتتاحي) يخرج بالمتوسط الحالي لا بالتكلفة الأصلية | `adjustments.service.ts:401-416`: `unitCost: wasIn ? undefined : unitCost`، أي أن عكس IN هو OUT بالمتوسط الحالي. والخطة §9.5 تقول: "عكس مستند مرحّل ينشئ حركات معاكسة بنفس `unit_cost` و`total_cost` الأصليين" | بعد مشتريات بسعر مختلف لا يلغي العكسُ القيدَ الأصلي، ويبقى رصيد في `INVENTORY_ADJUSTMENT` أو في **`OPENING_BALANCE_EQUITY`**. مثال: افتتاحي 10 @1 = 10، ثم شراء 10 @3 (المتوسط 2)، ثم العكس: خروج 10 @2 = 20، فيبقى 10 في حقوق الملكية الافتتاحية | للعكس: `totalCost` الأصلي من الحركة الأصلية. هذا يحتاج `applyMovement` يقبل `totalCost` صريحاً للخروج (مع الحماية: إذا خرج كامل الرصيد تُستعمل القيمة المتبقية). **قرار للمالك:** هل يُسمح بعكس الافتتاحي بعد حركات لاحقة أصلاً؟ | M | `adjustments.service.ts`، `stock-ledger.service.ts` |
| DB-06 | medium | `unit_cost` بدقة `DECIMAL(18,3)` خلافاً لـ §6.2 (18,6) | `stock_movements.unit_cost`، `stock_adjustment_lines.unit_cost`، `goods_note_lines.unit_cost`، `purchase_invoice_lines.unit_cost`، `purchase_return_lines.unit_cost` (أُنشئت في `20261108184703_phase4_inventory/migration.sql:113,192` و`20261108201338_phase5…:173`). فحص فعلي: 3 حركات في `erp_dev` فيها `ROUND((qty_in+qty_out)*unit_cost,3) <> total_cost` | بطاقة الصنف تعرض تكلفة وحدة لا تطابق الإجمالي. وكل مسار يعيد استعمال `unit_cost` المخزّن (DB-04، وعكس تسوية الخروج) يعيد التسعير بقيمة مقرّبة | migration توسّع الأعمدة الخمسة إلى `DECIMAL(18,6)`. التوسيع لا يفقد بيانات، لكنه `ALGORITHM=COPY` على `stock_movements`، أي قفل للجدول أثناء النسخ، فيُنفَّذ في نافذة صيانة. **قرار:** `purchase_invoice_lines.unit_cost` سعر شراء يُدخله المستخدم؛ هل يبقى 3 خانات مثل `unit_price` في المبيعات؟ | S | `schema.prisma` + migration جديدة |
| DB-07 | medium | حجم الـ pool ثابت على 10 ولا يُقرأ من الإعدادات | `prisma.service.ts:26`: `connectionLimit: 10`، و`parseDatabaseUrl` يتجاهل query string. لا `acquireTimeout` ولا `idleTimeout` | معاملة الترحيل تحجز اتصالاً طوال مدتها، فعشرة ترحيلات متزامنة في كل المنصة تستنفد الـ pool، والطلب الحادي عشر ينتظر `maxWait` (2 ث افتراضياً) ثم يفشل. وكل أمر Cron ينشئ pool آخر | متغير `DB_POOL_SIZE` (مثلاً 10-20) في `.env.example` وschema الإعدادات، يُحدَّد مقابل `max_user_connections` في الاستضافة؛ ومعه `acquireTimeout` صريح. ولأوامر Cron `DB_POOL_SIZE=2` | S | `prisma.service.ts`، `common/config/env.validation.ts`، `.env.example` |
| DB-08 | medium | تسلسل `JOURNAL_ENTRY` الواحد يسلسل كل ترحيلات المستأجر حتى COMMIT | كل ترحيل يستدعي `allocateEntryNo(…,'JOURNAL_ENTRY',…)` (مثلاً `sales-invoices.service.ts:591`، `vouchers.service.ts:120`)، والصف يبقى مقفولاً من لحظة المنح حتى COMMIT | داخل المستأجر الواحد لا يُرحَّل إلا مستند واحد في كل لحظة (من المنح حتى الإنهاء). مقبول لشركة صغيرة، لكنه يضخّم DB-01 وDB-09. الترتيب ثابت (أقفال المخزون، ثم تسلسل المستند، ثم JE)، فلا deadlock | (أ) إبقاؤه، فالتسلسل بلا فجوات متطلب، مع جعل المنح آخر خطوة قبل COMMIT (هو كذلك تقريباً)، وتقليل العمل بعده. (ب) **قرار للمالك:** هل يحتاج قيد اليومية رقماً تسلسلياً مستقلاً، أم يكفي رقم المستند المصدر؟ إلغاؤه للقيود الآلية يزيل القفل المشترك | S | `posting.service.ts` ومستدعوه |
| DB-09 | medium | N+1 داخل معاملة الترحيل (نحو 9 استعلامات لكل سطر) | لكل سطر: `item.findFirst` في المستدعي (`sales-invoices.service.ts:520`)، ثم في `applyMovement`: `item.findFirst` و`company.findFirst` (الصف نفسه في كل سطر، `:79-93`) و`findFirst`/`create`/`FOR UPDATE` مرتين، ثم insert وupdate مرتين، ثم `salesInvoiceLine.update` (`:540-545`) | فاتورة بـ 100 سطر ≈ 900 استعلام داخل معاملة تحجز الأقفال؛ زمن الشبكة إلى قاعدة الاستضافة يضرب في 900 | ضمن `applyMovements` (DB-02): الأصناف والشركة باستعلام واحد، والأقفال باستعلامين، و`createMany` للحركات. التحديثات لكل صف تبقى (Prisma لا يدعم bulk update بقيم مختلفة) أو `CASE` في `$executeRaw` | M | `stock-ledger.service.ts` والمستدعون (الملفات نفسها في DB-02، فيُنفَّذان معاً) |
| DB-10 | medium | فهارس ناقصة لأنماط الاستعلام الفعلية | القسم 4 (مطابقة كل استعلام بفهرسه) | قوائم المستندات تفرز كل مستندات المستأجر (filesort)؛ تقارير الأستاذ تزور كل قيود الشركة؛ عدّ الحصة الشهرية يعمل عند **كل** ترحيل بلا فهرس تاريخ | خطة الفهارس في القسم 4 | M | `schema.prisma` + migration واحدة |
| DB-11 | medium | `stock:verify` يحمّل كل الحركات إلى الذاكرة ولا يتحقق من القيمة | `stock-ledger.service.ts:296-305`: `findMany` على كل حركات المستأجر، والمقارنة على الكمية فقط. لا تحقق من `item_costs.total_qty/total_value`، ولا من رصيد حساب المخزون في الأستاذ | لا يكتشف DB-04 ولا DB-05. ومع ملايين الحركات تمتلئ الذاكرة | استعلام `GROUP BY` واحد (نموذجه في `orphans.sql`، الفحص `ic.vs_movements_value`)، يضاف إليه: مجموع `item_costs.total_value` يساوي رصيد حساب `INVENTORY` المرحّل. وأمر CLI `job:stock-verify` لكل المستأجرين | S | `stock-ledger.service.ts`، `jobs/cli.ts` |
| DB-12 | medium | `idempotency_keys` و`refresh_tokens` لا تُنظَّف أبداً | لا حذف حسب `expires_at` في `src` (الحذف الوحيد عند الفشل في `idempotency.interceptor.ts:117`). لا فهرس على `expires_at`. `response_json` يحمل استجابة كاملة لكل ترحيل | جدولان ينموان بلا حد؛ `idempotency_keys` أسرع الجداول نمواً بعد الحركات | أمر Cron يومي يحذف المنتهي على دفعات (`DELETE … WHERE expires_at < NOW() LIMIT 5000`)، وفهرس `(expires_at)` في الجدولين | S | `jobs/`، `schema.prisma` |
| DB-13 | medium | نسخة MariaDB غير موحّدة: dev على 10.4.32 (انتهى دعمها في 2024-06)، وCI على `mariadb:11` العائمة، والإنتاج غير محدد | `SELECT VERSION()` و`.github/workflows/*.yml:15` | سلوك القفل والعزل يختلف بين النسخ (`innodb_snapshot_isolation` موجود من 10.6.18، ومفعّل افتراضياً من 11.6.2). ما ينجح محلياً قد يفشل في الإنتاج أو العكس، و`11` في CI تتغير وحدها | **قرار:** تثبيت نسخة LTS واحدة (10.11 أو 11.4) في dev وCI (`mariadb:11.4.x`) والإنتاج، وإضافتها إلى فحص `preflight` | S | `.github/workflows/*.yml`، `jobs/preflight.service.ts`، docs |
| DB-14 | low | تقارير بلا حد للصفوف | الأستاذ العام وكشف الطرف `findMany` دون `take` (`reports.service.ts:359,442`)؛ الأعمار تحمّل كل فواتير الأجل حتى التاريخ (`sales-invoices.service.ts:84`) | حساب الصندوق أو المبيعات عن سنة يعني عشرات آلاف الصفوف مع join في طلب واحد | سقف `REPORT_TOO_LARGE` كما في بطاقة الصنف، أو ترقيم؛ وللأعمار: حساب المتبقي لكل فاتورة في SQL واستبعاد المسددة | M | `reports.service.ts`، `sales-invoices.service.ts`، `purchase-invoices.service.ts` |
| DB-15 | low | مراجع متعددة الأشكال بلا FK | `journal_lines.party_id` و`branch_id`، `allocations.document_type/document_id`، `einvoice_submissions.document_type/document_id`، `journal_entries.source_type/source_id`، `stock_movements.source_*` | لا حماية من اليتامى في القاعدة (الفحص الحالي: 0 يتامى) | جزئياً عبر الدمج (القسم 3، المقترح A يحوّل `allocations` و`einvoice_submissions` إلى FK حقيقي). و`journal_lines.party_id` يمكن ربطه بـ `parties` مباشرة لأن كل الأطراف في جدول واحد: FK مركّب `[tenantId, partyId]` | S | `schema.prisma` |
| DB-16 | low | القيود الفريدة لأرقام المستندات على `(tenant_id, no)` لا `(tenant_id, company_id, no)` | `@@unique([tenantId, invoiceNo])` ومثلها `docNo` و`receiptNo` و`paymentNo` و`transferNo` و`returnNo`. والبادئة لا تتضمن الشركة (`fiscal.service.ts:102`) | الخطة §5.1: "تعدد الشركات لاحقاً لا يحتاج تغيير الجداول"، وهذا غير صحيح هنا: شركتان في مستأجر تتصادمان في `SI-2026-000001` | تحويلها إلى `(tenant_id, company_id, xxx_no)` في migration واحدة (لا تغيير بيانات) | S | `schema.prisma` |
| DB-17 | low | أعمدة ميتة | `sales_invoices.reversal_of_id`، `purchase_invoices.reversal_of_id`، `goods_notes.reversal_of_id`، مع علاقاتها وفهارسها: لا قراءة ولا كتابة في `src` | ضجيج في المخطط وفهارس تُصان دون فائدة | حذفها، أو توثيق أنها محجوزة. وفي `receipts` و`payments` و`cash_transfers` عمود `status` افتراضيه `POSTED` ولا مسودات | S | `schema.prisma` |
| DB-18 | low | الترتيب: القاعدة `utf8mb4_general_ci` والجداول `utf8mb4_unicode_ci`؛ والرموز فريدة دون حساسية لحالة الأحرف | `information_schema.schemata`/`columns` | أي جدول يُنشأ بـ SQL خام يرث `general_ci`، فيظهر "Illegal mix of collations" عند join. و`ITM-a` و`ITM-A` متساويان في القيود الفريدة (قد يكون مقصوداً) | `ALTER DATABASE … COLLATE utf8mb4_unicode_ci` في وثيقة الإعداد، أو `uca1400_ai_ci` عند الانتقال إلى 10.10+ أو 11.x. وقرار صريح بأن الرموز غير حساسة للحالة | S | docs/runbook |
| DB-19 | low | منطق المخزون السالب يفسد المتوسط (الإعداد مغلق في الواجهة) | `stock-ledger.service.ts:209-232`: عند تجاوز الرصيد تصبح `total_value` سالبة ويُصفَّر المتوسط، وتكلفة البيع التالية صفر. والسماح يُفحص على رصيد المستودع، بينما التكلفة على مستوى الشركة | لا أثر الآن؛ يصبح خطأً محاسبياً يوم يُفعَّل | منع تفعيل `allow_negative_stock` في الخادم أيضاً حتى يصدر ADR لتكلفة الكميات المباعة على المكشوف | S | `stock-ledger.service.ts` |
| DB-20 | low | سباق إغلاق الفترة | `resolveOpenPeriod` يقرأ الحالة دون قفل (`posting.service.ts:~281`) | ترحيل جارٍ ينجح في فترة أُغلقت بين قراءته وCOMMIT | `SELECT … FROM fiscal_periods … LOCK IN SHARE MODE` في الترحيل، و`FOR UPDATE` في الإغلاق | S | `posting.service.ts`، `fiscal.service.ts` |
| DB-21 | low | فهارس `audit_logs` بلا قارئ، و`(entity_type, entity_id)` بلا `tenant_id` | لا قراءة لـ `auditLog` في `src` | كلفة إدراج دون فائدة؛ وأي شاشة سجل مستقبلية على هذا الفهرس تبحث عبر المستأجرين | إبقاء `(tenant_id, created_at)`، وتحويل الآخر إلى `(tenant_id, entity_type, entity_id)` | S | `schema.prisma` |
| DB-22 | low | ترقيم الحركات بـ OFFSET و`COUNT(*)` | `stock-reports.service.ts:310-320` | الصفحات البعيدة تمسح كل ما قبلها | keyset على `(movement_date, id)` مع فهرس القسم 4 | S | `stock-reports.service.ts` |

ملاحظات صغيرة لا تستحق بنداً: `catalog.service.ts:283` يستعمل `Number(factorToBase)` على كمية (مخالف لـ CLAUDE.md). وبحث الأصناف `contains` على ثلاثة أعمدة لا يُخدم بفهرس، وهو مقبول حتى بضعة آلاف صنف، وبعدها FULLTEXT.

---

## 3. لماذا 61 جدولاً؟ وما الذي يُدمج؟

### 3.1 الجواب المختصر

61 جدولاً لنظام فيه محاسبة ومخزون ومبيعات ومشتريات وخزينة وفوترة إلكترونية وSaaS **عدد معتدل وليس منتفخاً**. التوزيع:

| المجموعة | الجداول | العدد |
|---|---|---|
| المنصة (غير مستأجر) | plans, currencies, countries, roles, role_permissions, users, refresh_tokens, error_events, audit_logs, tenants, subscriptions | 11 |
| التنظيم | companies, branches, tenant_memberships, membership_branches, attachments, idempotency_keys | 6 |
| الإعدادات والمراجع | units, tax_categories, payment_methods, fiscal_years, fiscal_periods, accounts, account_mappings, document_sequences | 8 |
| القيود | journal_entries, journal_lines | 2 |
| بيانات الأصناف | item_groups, items, item_units, item_barcodes, warehouses | 5 |
| دفتر المخزون والإسقاطات | stock_movements, stock_balances, item_costs | 3 |
| مستندات المخزون | stock_adjustments(+lines), stock_transfers(+lines), stock_counts(+lines) | 6 |
| الأطراف وحسابات النقد | parties, cash_boxes, bank_accounts | 3 |
| مستندات التجارة | sales_invoices, purchase_invoices, sales_returns, purchase_returns, goods_notes (+5 lines) | 10 |
| مستندات الخزينة | receipts, payments, allocations, cash_transfers | 4 |
| الفوترة الإلكترونية | einvoice_settings, einvoice_submissions, einvoice_attempts | 3 |

**التكلفة الحقيقية ليست عدد الجداول بل التكرار.** أربع رؤوس تجارية وأربعة جداول أسطر شبه متطابقة (الأعمدة نفسها تقريباً: `qty, qty_base, unit_price|unit_cost, discount_*, net_amount, tax_*, line_total`)، وخلفها أربع خدمات ترحيل متشابهة. ومعظم عيوب هذه المراجعة (DB-02، DB-09) مكررة في 6 أماكن لهذا السبب. ADR-013 (المشتريات) سيضيف أوامر شراء وطلبات وعروض أسعار، أي **6-8 جداول أخرى** بالنمط نفسه إن لم يتغير النموذج. فالقرار الحقيقي: نموذج مستند موحّد قبل ADR-013، أم بعده.

### 3.2 المقترحات (قبل ← بعد)

#### A. مستندات التجارة: 10 جداول ← 2 (توفير 8، أو 6 إن بقيت أذون البضاعة منفصلة)

- **قبل:** `sales_invoices`, `sales_returns`, `purchase_invoices`, `purchase_returns`, `goods_notes`، ولكلٍّ جدول أسطر.
- **بعد:** `trade_documents (id, tenant_id, company_id, branch_id, doc_kind ENUM('SI','SR','PI','PR','GRN','GIN'), doc_no, doc_date, due_date, party_id, warehouse_id, payment_type, cash_account_id, original_document_id → trade_documents, supplier_invoice_no, supplier_invoice_date, status, net_total, tax_total, grand_total, paid_amount, cost_total, journal_entry_id, …)`، و`trade_document_lines (id, tenant_id, document_id, line_no, item_id, item_unit_id, original_line_id → trade_document_lines, qty, qty_base, unit_price, discount_pct, discount_amount, net_amount, tax_category_id, tax_rate, tax_amount, line_total, unit_cost DECIMAL(18,6), cost_total)`.
- **المكسب:**
  - FK حقيقي بدل المرجع متعدد الأشكال: `allocations.document_id` و`einvoice_submissions.document_id` (DB-15).
  - خدمة ترحيل واحدة بمعامل اتجاه (IN/OUT)، فإصلاح DB-02 وDB-09 مرة واحدة لا ست مرات.
  - أوامر الشراء والبيع في ADR-013 تصبح قيماً جديدة في `doc_kind` لا جداول جديدة.
  - التقارير الموحدة (ملخص المبيعات والمشتريات، الضريبة) استعلام واحد.
- **الثمن:**
  - **أنواع Prisma:** نوع واحد بحقول nullable كثيرة بدل أنواع دقيقة؛ يُعوَّض بـ discriminated unions في طبقة الخدمة وبـ DTO منفصل لكل نوع (الـ API لا يتغير).
  - **القيود:** قواعد مثل "المرتجع يجب أن يكون له `original_document_id`" أو "فاتورة الشراء لها `supplier_invoice_no`" لا يعبّر عنها Prisma؛ تُكتب `CHECK` في migration SQL (MariaDB ≥ 10.2 تنفذها) وتُختبر.
  - **المفاتيح المركبة `[tenantId, id]`:** لا تتأثر. والمرجع الذاتي `[tenantId, originalDocumentId]` يعمل كما يعمل الآن في `reversalOf`.
  - **الفهارس:** كل فهرس يبدأ بـ `(tenant_id, company_id, doc_kind, …)`، والجدول الأكبر يجمع المبيعات والمشتريات. لا مشكلة أداء بالحجم المتوقع لـ SME إذا كان `doc_kind` في بادئة كل فهرس.
  - **ثبات المرحّل:** لا يتغير المبدأ؛ ويصبح trigger أو فحص "لا UPDATE على `status='POSTED'`" في مكان واحد.
  - **الصلاحيات:** `sales_invoice.post` و`purchase_invoice.post` تبقى منفصلة حسب `doc_kind`.
- **مخاطر الترحيل: عالية.** المعرفات تتصادم بين الجداول الأربعة (كلٌّ له autoincrement). ونقل البيانات المرحّلة يتطلب **إعادة ترقيم المعرفات** وتحديث كل من يشير إليها: `journal_entries.source_id`، `stock_movements.source_id` و`source_line_id`، `allocations.document_id`، `einvoice_submissions.document_id`، `*_return_lines.original_line_id`. وهذه كلها بيانات مرحّلة يُفترض أنها لا تُعدَّل، وبعضها أُرسل إلى JoFotara. البديل الآمن: الإبقاء على المعرفات القديمة بنطاقات منفصلة (مثلاً `id + 10^12 × kind`) أو استعمال `INSERT … SELECT` مع جدول مطابقة `old_id → new_id` مؤقت ومراجعة SQL كاملة.
- **التوصية:** **لا تدمج الآن ما دام لا عملاء.** القاعدة فارغة تقريباً، فهذا أرخص وقت للدمج إن كان سيحدث أصلاً. إن قرر المالك الدمج فليكن **قبل تنفيذ ADR-013 وقبل أول عميل حقيقي**. وإن لم يُدمج، فيُستخرج على الأقل `TradePostingService` مشترك فوق الجداول الحالية (المكسب الأكبر نفسه دون migration).

#### B. مستندات المخزون: 6 جداول ← 2 (+ الجرد)، توفير 2-4

- **قبل:** `stock_adjustments`(+lines)، `stock_transfers`(+lines)، `stock_counts`(+lines).
- **بعد:** `stock_documents (doc_kind ADJ_IN|ADJ_OUT|OPENING|COUNT_ADJ|TRANSFER, warehouse_id, to_warehouse_id, …)` + `stock_document_lines (qty_in, qty_out, unit_cost(18,6), …)`. أما الجرد فيبقى منفصلاً، لأن دورة حياته مختلفة (ورقة جرد بكمية نظام وكمية معدودة، تنتج تسوية).
- وإن صار المقترح A فأذون البضاعة GRN/GIN تنتمي إليه أو إلى هنا، لا إلى الاثنين.
- **الثمن:** أقل من A؛ لا مراجع خارجية إلا `journal_entries.source_id` و`stock_movements.source_id` و`stock_counts.adjustment_id`.
- **مخاطر الترحيل: متوسطة.** والقيمة متوسطة.

#### C. سندات الخزينة: `receipts` + `payments` ← `cash_vouchers (direction IN|OUT)`، توفير 1

- `allocations` يصبح `voucher_id` واحداً بدل `receipt_id`/`payment_id` الحصريين (وهي حصرية دون CHECK الآن).
- **الثمن:** `expense_account_id` موجود فقط في سند الصرف (nullable). والترقيم RV/PV يبقى حسب `direction`.
- **مخاطر الترحيل: منخفضة إلى متوسطة** (المراجع: `journal_entries.source_id` و`allocations`).
- **التوصية:** يُنفَّذ مع A إن نُفِّذ، وإلا فلا يستحق وحده.

#### D. `cash_boxes` + `bank_accounts` ← `cash_accounts (kind CASH|BANK)`، توفير 1

- قيمة منخفضة. كلاهما واجهة لحساب في الشجرة.
- **مخاطر منخفضة.** اختياري.

#### E. ما **لا** يُدمج (والدمج هنا يضر)

- **جداول المراجع (`units`, `tax_categories`, `payment_methods`)** في "جدول مراجع عام" واحد (one true lookup table): نمط سيئ معروف. تفقد FK المحدد (لا يمنع شيءٌ ربط سطر فاتورة بـ "وحدة" في خانة الضريبة)، وتفقد الأعمدة الخاصة (`rate`, `einvoice_code`, `un_ece_code`)، وتفقد أنواع Prisma. **لا.**
- **`stock_balances` + `item_costs`:** حبيبات مختلفة (مستودع×صنف مقابل شركة×صنف)، وكلاهما مقفول في الترحيل. دمجهما يغيّر نموذج التكلفة نفسه. **لا.**
- **`journal_entries`/`journal_lines`** مع المستندات: فصل الأستاذ عن المستندات هو أساس الثبات والتقارير. **لا.**
- **`fiscal_years` + `fiscal_periods`**، و`document_sequences`، و`account_mappings`: كلٌّ له قيد فريد وقفل مستقل. **لا.**
- **`einvoice_attempts` داخل `einvoice_submissions` كـ JSON:** يفقد سجل التدقيق القابل للاستعلام. **لا.**
- **`companies` داخل `tenants`** (1:1 في الـ MVP): يكسر الاستعداد المعلن لتعدد الشركات. **لا.**
- **`role_permissions` إلى JSON أو ثوابت في الكود:** ممكن إن بقيت الأدوار نظامية فقط (`is_system`)، لكنه يغلق باب الأدوار المخصصة. **قرار للمالك**؛ التوفير جدول واحد.
- **`membership_branches` إلى JSON:** يفقد FK على الفرع. **لا.**

#### F. الحصيلة

| السيناريو | الجداول | ملاحظات |
|---|---|---|
| الحالي | 61 | — |
| C + D فقط | 59 | منخفض المخاطر، قيمة قليلة |
| A + C (+D) | 52-53 | القيمة الأكبر: كود ترحيل واحد، وFK حقيقي، وADR-013 دون جداول جديدة |
| A + B + C + D | 49-51 | الأقصى المعقول |

### 3.3 ترتيب التنفيذ المقترح (إن وافق المالك)

1. **أولاً، دون تغيير مخطط:** إصلاح DB-01، DB-02، DB-03، DB-04، DB-05 فوق الجداول الحالية، لأنها أخطاء تمس الأرقام الآن.
2. استخراج `TradePostingService` مشترك فوق الجداول الحالية (يمهّد لـ A ويقلل التكرار فوراً). يمكن الاكتفاء بهذا.
3. فهارس القسم 4، وتوسيع `unit_cost` (DB-06)، وقيود الترقيم لكل شركة (DB-16): migration واحدة.
4. إن قرر المالك الدمج: C ثم A ثم B، كلٌّ في migration مستقلة مع جدول مطابقة معرفات، واختبارات ذهبية قبل وبعد (§18)، و`stock:verify` المحسّن (DB-11) وميزان المراجعة متساويان قبل وبعد. ويُنفَّذ قبل ADR-013 وقبل أول عميل.

---

## 4. خطة الفهارس

مبنية على مطابقة كل استعلام ساخن (`review-database-scripts/query-index-map.md`، ملخصه هنا) بـ `SHOW INDEX` الفعلي على `erp_dev`. **لم تُقَس بـ EXPLAIN على حجم** (القسم 5). فهارس FK الضمنية موجودة فعلاً، مثل `stock_balances(tenant_id,item_id)` و`journal_entries(tenant_id,reversal_of_id)` و`*_returns(tenant_id,original_invoice_id)` و`allocations(tenant_id,receipt_id|payment_id)`، فلا حاجة لإضافتها، وإنما يُستحسن تعريفها في `schema.prisma` لتكون صريحة.

### 4.1 إضافة

| الجدول | الفهرس | يخدم | الدليل |
|---|---|---|---|
| journal_entries | `(tenant_id, company_id, status, entry_date)` | ميزان المراجعة، قائمة الدخل، الميزانية، الأستاذ، الافتتاحي (كل `entry: {companyId, status:'POSTED', entryDate}`) | `reports.service.ts:133,181,359,382`. الموجود `(tenant,company,entry_date)` بلا `status`، فكل صف قيد في المدى يُقرأ للتحقق من الحالة |
| journal_lines | **تغيير** `(tenant_id, account_id)` ← `(tenant_id, account_id, journal_entry_id)` | الأستاذ العام ورصيد الصندوق: الربط بالقيد من الفهرس | `reports.service.ts:359`، `treasury-reports.service.ts:228` |
| journal_lines | `(tenant_id, account_id, party_id)` | أرصدة حسابات المراقبة لكل طرف (الأعمار) | `reports.service.ts:527` يبدأ من الحساب ويجمّع حسب الطرف |
| journal_lines | **تغيير** `(tenant_id, party_type, party_id)` ← `(tenant_id, party_type, party_id, journal_entry_id)` | كشف حساب الطرف | `reports.service.ts:442` |
| sales_invoices، purchase_invoices | `(tenant_id, company_id, status, invoice_date)` | عدّ الحصة الشهرية عند **كل ترحيل** (`sales-invoices.service.ts:512`)، الملخصات، لوحة التحكم | الموجود `(tenant,status)` فقط |
| sales_invoices، purchase_invoices | `(tenant_id, company_id, invoice_date, id)` | القوائم `ORDER BY invoice_date DESC, id DESC LIMIT 300` دون filesort | `sales-invoices.service.ts:263` |
| sales_invoices | `(tenant_id, customer_id, status, payment_type, invoice_date)` (ومثله `supplier_id` في المشتريات) | تسوية الأقدم أولاً عند كل سند قبض أو تخصيص | `sales-invoices.service.ts:231` (يحل محل FK الضمني `(tenant,customer_id)` لأنه بادئته) |
| sales_returns، purchase_returns، receipts، payments، goods_notes | `(tenant_id, company_id, <date>, id)` | القوائم المرتبة بالتاريخ | لا فهرس تاريخ اليوم |
| stock_movements | `(tenant_id, movement_date, id)` | قائمة الحركات (keyset، DB-22)، `items_balance`، `stock:verify` | `stock-reports.service.ts:93,310`، `stock-ledger.service.ts:296` |
| idempotency_keys، refresh_tokens | `(expires_at)` | أمر التنظيف (DB-12) | — |
| audit_logs | `(tenant_id, entity_type, entity_id)` بدل `(entity_type, entity_id)` | أي قارئ مستقبلي | DB-21 |

### 4.2 حذف

| الفهرس | السبب |
|---|---|
| `journal_entries(tenant_id, status)` | انتقائية ضعيفة؛ يغطيه الفهرس الجديد `(tenant,company,status,entry_date)` لاستعلامات الشركة |
| `journal_lines(tenant_id, account_id)` | يحل محله الأعرض (التغيير أعلاه)، مع ملاحظة أن FK `[tenantId, accountId]` يحتاج فهرساً بادئته هذان العمودان، وهو متوفر في الجديد |
| `audit_logs(entity_type, entity_id)` | بلا قارئ وبلا `tenant_id` |
| `*_invoices/returns(tenant_id, status)` | بعد إضافة `(tenant,company,status,date)`. تحقق قبل الحذف: استعلامات القفل `WHERE id = ?` لا تحتاجه |
| أعمدة `reversal_of_id` الميتة وفهارسها (DB-17) | لا استعمال |

### 4.3 إبقاء (للتوضيح)

- `@@unique([tenantId, id])` بجانب PK: مطلوب للـ FK المركبة، فلا يُحذف.
- `stock_movements(tenant,item,movement_date)` لبطاقة الصنف، و`(tenant,source_type,source_id)` للعكس، و`(tenant,warehouse,item)`.
- `einvoice_submissions(status, next_attempt_at)` و`(claim_token)` لعامل الـ outbox.
- `items(tenant,item_kind)` و`parties(tenant,party_type)` ضعيفة الانتقائية لكنها رخيصة. تُترك ولا يُبنى عليها.

---

## 5. ما لم أستطع التحقق منه

1. **EXPLAIN على حجم حقيقي (50k حركة، 50k سطر قيد): لم يتم.** امتلأ القرص C: (0 MB) أثناء التوليد، وأوقفت المولد قبل أي ترحيل (المستأجر 17 «Review review-database Volume» فيه 200 صنف و70 طرفاً و200 مسودة شراء). كذلك ضرب حد الطلبات العام (100/دقيقة لكل IP، `common/throttle/throttle.ts:29`) سرعة التوليد في نحو 30 دقيقة. السكربتات جاهزة:
   - `review-database-scripts/run.mjs` يولّد 600 فاتورة شراء و550 فاتورة بيع بـ 40 سطراً، و250 قيداً بـ 100 سطر، عبر API على 3414.
   - `review-database-scripts/capture.mjs <tenantId> <out.md>` يشغّل 15 استعلاماً ساخناً بعميل Prisma نفسه، ويلتقط SQL الذي يولّده، ويشغّل EXPLAIN عليه ويقيس الزمن.
   - `review-database-scripts/orphans.sql` فحوص اليتامى والتوازن والقيمة.
2. **إعادة إنتاج deadlock (DB-02) وسباق أول حركة (DB-03) وأخطاء العكس (DB-04/05) عبر API: لم تتم** للسبب نفسه. وDB-04 يحتاج مستودعين، وباقة TRIAL تسمح بواحد فقط. كلها مقروءة في الكود وبحساب يدوي، لا مُثبتة بتشغيل.
3. **زمن الترحيل الفعلي لكل سطر** (لتقدير قرب DB-01 من حد 5 ث): لم يُقَس.
4. سيناريوهات §18 الذهبية لم تُشغَّل (اختبارات e2e ممنوعة في هذه الجلسة).
5. نسخة MariaDB في الإنتاج غير موثقة، فلم أتحقق من سلوك `innodb_snapshot_isolation` على نسخة ≥ 11.6.2 فعلياً. الكود صحيح بالقراءة، ووصل `initSql` إلى الـ pool متحقق منه في كود المحوّل.

---

## 6. مكاسب سريعة

1. DB-01: سطر `transactionOptions: { timeout: 30000, maxWait: 5000 }` في `prisma.service.ts`.
2. DB-04: سطر واحد في `transfers.service.ts`: الدخول بـ `out.unitCost`.
3. DB-03: `INSERT … ON DUPLICATE KEY UPDATE` بدل `findFirst`+`create`.
4. DB-07: `DB_POOL_SIZE` في الإعدادات.
5. DB-12: أمر Cron لتنظيف `idempotency_keys` و`refresh_tokens`.
6. DB-13: تثبيت `mariadb:11.4` في CI.
7. DB-16 + DB-06 + فهارس القسم 4 في migration واحدة، قبل وجود بيانات إنتاج.

## 7. قرارات مطلوبة من المالك

1. **الدمج (القسم 3):** نموذج مستند تجاري موحّد (A + C) قبل ADR-013 وقبل أول عميل، أم الاكتفاء بخدمة ترحيل مشتركة فوق الجداول الحالية؟ التوصية: الخدمة المشتركة الآن، والدمج فقط إن كان سيحدث قبل أول عميل.
2. **DB-05:** هل يُسمح بعكس رصيد افتتاحي أو تسوية دخول بعد حركات لاحقة على الصنف؟ وإن سُمح، فالعكس بالتكلفة الأصلية مع فرق إلى `INVENTORY_ADJUSTMENT`؟
3. **DB-06:** هل `purchase_invoice_lines.unit_cost` "سعر" (3 خانات) أم "تكلفة وحدة" (6 خانات)؟
4. **DB-08:** هل يلزم رقم تسلسلي مستقل لكل قيد آلي، أم يكفي رقم المستند المصدر؟
5. **DB-13:** نسخة MariaDB المعتمدة للإنتاج والتطوير وCI.
6. **DB-18:** هل الرموز (الأصناف، العملاء، الباركود) غير حساسة لحالة الأحرف عن قصد؟
7. **`role_permissions`:** هل ستكون هناك أدوار مخصصة لكل مستأجر؟ (يحدد إن كان الجدول يبقى).

---

## الملخص

- العدد: **high 5** (DB-01..05)، **medium 9** (DB-06..14)، **low 8** (DB-15..22). لا critical.
- **الأول، DB-01:** لا مهلة لمعاملات الترحيل، فتسري 5 ث الافتراضية، والخطة تطلب 30 ث. وP2028 لا يُعاد.
- **الثاني، DB-02 + DB-03:** أقفال المخزون بترتيب الأسطر لا بترتيب ثابت، و`findFirst→create` عند أول حركة، فتظهر deadlocks وP2002 تحت التزامن.
- **الثالث، DB-04 + DB-05:** عكس التحويل وعكس التسوية لا يستعملان التكلفة الأصلية، فيفترق المخزون عن الأستاذ، ويبقى رصيد في حقوق الملكية الافتتاحية.
- 61 جدولاً ليس عدداً مبالغاً فيه. التكرار في مستندات التجارة هو المشكلة، والقرار المطلوب: هل يُوحَّد قبل ADR-013؟
