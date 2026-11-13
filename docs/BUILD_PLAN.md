# وثيقة بناء نظام المحاسبة والمستودعات السحابي — نطاق MVP

**الإصدار:** 2.0 (تحل محل الإصدار 1.0)
**التاريخ:** 7 نوفمبر 2026
**السوق:** الشركات الصغيرة والمتوسطة في الأردن
**نموذج العمل:** منتج SaaS تجاري باشتراك شهري/سنوي
**فريق التطوير:** مطور واحد مع أداة برمجة بالذكاء الاصطناعي (Claude Code)
**اسم المشروع المؤقت:** ERP Cloud
**مكان الملف في المشروع:** `docs/BUILD_PLAN.md`

------------------------------------------------------------------------

## 0. ملخص التغييرات عن الإصدار 1.0

| الموضوع | الإصدار 1.0 | الإصدار 2.0 |
|---|---|---|
| النطاق | 10 مراحل شاملة | MVP مقلّص قابل للإطلاق، والباقي في خارطة طريق |
| تقييم المخزون | المتوسط المرجح + FIFO | المتوسط المرجح فقط، والتصميم يسمح بإضافة FIFO لاحقاً |
| المستند بتاريخ سابق | غير محسوم | قاعدة صريحة تمنعه للحركات المخزنية (القسم 9.4) |
| JoFotara | المرحلة 8 | داخل الـ MVP، ونموذج البيانات يراعيها من المرحلة 5 |
| تطبيق Android | المرحلة 9 | مؤجل؛ الويب متجاوب للجوال |
| تعدد الشركات للمستأجر | مفتوح | شركة واحدة لكل مستأجر في الـ MVP، والجداول جاهزة للتعدد |
| تعدد العملات | كامل | JOD فقط فعلياً، والحقول موجودة |
| الاشتراكات والباقات | غير مصممة | مصممة (القسم 13) |
| الأرصدة الافتتاحية والاستيراد | المرحلة 10 | جزء أساسي من الـ MVP |
| المعرفات وBigInt | غير محسوم | محسوم (القسم 6.3) |
| أرقام المستندات | غير محسوم | تُمنح عند الترحيل، بلا فجوات (القسم 11) |
| تفاصيل Prisma (القفل، المهلة، العزل) | غير مذكورة | محددة (الأقسام 5 و10) |

------------------------------------------------------------------------

## 1. الهدف من الـ MVP

يكون الـ MVP ناجحاً عندما تستطيع شركة أردنية صغيرة أن:

1. تشترك وتُعدّ حسابها خلال أقل من ساعة، بمساعدة معالج إعداد وشجرة حسابات جاهزة.
2. تستورد أصنافها وعملاءها ومورديها وأرصدتها الافتتاحية من Excel.
3. تسجل المشتريات والمبيعات والمرتجعات، ويتحدث المخزون والقيود تلقائياً.
4. ترسل فواتيرها إلى JoFotara وتطبعها برمز QR.
5. تسجل المقبوضات والمدفوعات وتخصصها على الفواتير.
6. تستخرج ميزان المراجعة وكشوف الحسابات وتقارير المخزون وقائمة الدخل والميزانية.
7. تثق بأن بياناتها معزولة تماماً عن أي شركة أخرى.

------------------------------------------------------------------------

## 2. النطاق

### 2.1 داخل الـ MVP

- المنصة: المستأجرون، المستخدمون، الأدوار الجاهزة، الجلسات، سجل التدقيق.
- الشركة والفروع والمستودعات.
- شجرة الحسابات، السنوات والفترات المالية، القيود اليدوية، العكس، الأستاذ، ميزان المراجعة.
- الأصناف، المجموعات، الوحدات والتحويل، الباركود.
- حركات المخزون: استلام وصرف يدوي، تحويل بين المستودعات، جرد وتسوية، رصيد افتتاحي.
- تقييم المخزون بالمتوسط المرجح المتحرك.
- العملاء والموردون.
- فواتير البيع النقدية والآجلة، ومرتجعات المبيعات.
- فواتير الشراء النقدية والآجلة، ومرتجعات المشتريات.
- الصناديق والحسابات البنكية، سندات القبض والصرف، التحويلات بينها، التخصيص على الفواتير.
- الضريبة العامة على المبيعات بنسب قابلة للإعداد.
- تكامل JoFotara لفواتير البيع والمرتجعات.
- التقارير الأساسية والطباعة وتصدير PDF وExcel.
- الاشتراكات والباقات والفترة التجريبية.
- معالج الإعداد، الاستيراد من Excel، تصدير بيانات المستأجر.
- واجهة ويب عربية RTL وإنجليزية LTR، متجاوبة مع الكمبيوتر والتابلت والجوال.

### 2.2 مؤجل إلى ما بعد الإطلاق (خارطة الطريق، القسم 20)

FIFO، التشغيلات والصلاحية، عروض الأسعار، أوامر البيع والشراء، طلبات الشراء، استلام البضاعة المنفصل عن الفاتورة، التسوية البنكية، مراكز التكلفة، قائمة التدفقات النقدية، قيد إقفال السنة الآلي، تعدد العملات الفعلي، تعدد الشركات للمستأجر الواحد، محرر الصلاحيات المرن، تطبيق Android، الضرائب الخاصة إن لم تكن مطلوبة لأول العملاء.

### 2.3 خارج النطاق نهائياً للإصدار الأول

الرواتب، الموارد البشرية، التصنيع، CRM، التجارة الإلكترونية، iOS، قاعدة بيانات مستقلة لكل عميل.

------------------------------------------------------------------------

## 3. القرارات التقنية المعتمدة

| الطبقة | التقنية | ملاحظات |
|---|---|---|
| الاستضافة | Hostinger Cloud (تم التحقق من دعم Node المستمر وCron وحدود الاتصالات) | يجب أن يبقى التطبيق قابلاً للنقل إلى VPS دون تعديل في الكود |
| قاعدة البيانات | MariaDB/MySQL المتاح في الخطة | InnoDB، `utf8mb4` |
| Backend | Node.js LTS + NestJS + TypeScript | Modular Monolith |
| ORM | Prisma | اتبع التوثيق الرسمي لإصدار Prisma المعتمد لطريقة ربط MariaDB |
| سياق الطلب | `nestjs-cls` (AsyncLocalStorage) | لحمل tenant/user/branch عبر الطبقات |
| الأرقام العشرية | `Prisma.Decimal` / `decimal.js` | ممنوع استخدام `number` للمبالغ |
| التحقق من المدخلات | `class-validator` + `class-transformer` | |
| التوثيق | `@nestjs/swagger` (OpenAPI) | |
| المصادقة | Access Token قصير + Refresh Token دوّار | Argon2id لكلمات المرور |
| Web | React + TypeScript + Vite | |
| مكتبة الواجهة | Ant Design | جداول ونماذج قوية ودعم RTL |
| جلب البيانات | TanStack Query | |
| عميل API | مولد من OpenAPI (مثل orval) | لا تكتب الأنواع يدوياً مرتين |
| i18n | react-i18next | `ar` افتراضي، `en` |
| PDF | pdfmake مع خط عربي مضمّن | لا تستخدم Puppeteer/Chromium على الاستضافة المشتركة |
| Excel | exceljs | للتصدير والاستيراد |
| الاختبارات | Jest (API) + Vitest (Web) + Playwright (E2E لاحقاً) | قاعدة بيانات اختبار MariaDB حقيقية للاختبارات التكاملية |
| إدارة الحزم | pnpm workspaces | |
| CI | GitHub Actions | lint + typecheck + test على كل push |

### 3.1 مبدأ قابلية النقل

- كل الإعدادات عبر متغيرات بيئة يتحقق منها التطبيق عند الإقلاع (مثلاً بـ zod أو `@nestjs/config` مع schema).
- لا يعتمد الكود على أي مسار أو ميزة خاصة بلوحة Hostinger.
- المهام المجدولة تُنفذ عبر endpoint داخلي محمي أو أمر CLI يستدعيه Cron، وليس عبر مؤقتات داخل العملية فقط.
- المرفقات عبر واجهة تخزين مجردة (`StorageService`)، بتنفيذ أولي على نظام الملفات.

------------------------------------------------------------------------

## 4. المعمارية وتنظيم المستودع

### 4.1 الهيكل

```text
erp-system/
  apps/
    api/                      # NestJS
      src/
        common/               # guards, interceptors, filters, decimal utils, cls
        platform/             # auth, tenants, users, roles, subscriptions, audit
        settings/             # currencies, units, taxes, payment methods, sequences
        accounting/           # accounts, fiscal periods, journal, posting engine
        inventory/            # items, warehouses, movements, costing
        parties/              # customers, suppliers
        sales/                # sales invoices, sales returns
        purchasing/           # purchase invoices, purchase returns
        treasury/             # cash boxes, banks, receipts, payments, allocations
        einvoice/             # JoFotara
        reports/              # financial and inventory reports, pdf, excel
        onboarding/           # setup wizard, templates, import, export
        jobs/                 # scheduled job runners
      prisma/
        schema.prisma
        migrations/
        seed/
      test/
    web/                      # React
  packages/
    api-client/               # مولد من OpenAPI
  docs/
    BUILD_PLAN.md             # هذه الوثيقة
    decisions/                # سجل القرارات (ADR) بصيغة 0001-xxx.md
    phase-reports/            # تقرير نهاية كل مرحلة
  CLAUDE.md
  README.md
```

### 4.2 قواعد الاتصال

- الواجهة لا تتصل بقاعدة البيانات مباشرة، وكل شيء عبر `/api/v1`.
- لا يُقبل `tenant_id` من العميل كمصدر للصلاحية.
- منطق المحاسبة والمخزون والضريبة في Backend فقط.
- الواجهة تعرض المجاميع للمعاينة، لكن الخادم يعيد حسابها دائماً، والقيمة المحفوظة هي قيمة الخادم.
- لا أسرار في الواجهة.

### 4.3 حدود الوحدات

- كل وحدة تكشف خدماتها عبر واجهة عامة (exported service)، ولا تستعلم وحدة جداول وحدة أخرى مباشرة إلا عبر خدمتها.
- **`PostingService`** في وحدة المحاسبة هو المكان الوحيد الذي ينشئ قيوداً مرحّلة.
- **`StockLedgerService`** في وحدة المخزون هو المكان الوحيد الذي ينشئ حركات مخزنية ويحدّث الأرصدة والتكلفة.
- مستندات البيع والشراء والخزينة تبني "طلب ترحيل" وتمرره لهاتين الخدمتين داخل المعاملة نفسها.

------------------------------------------------------------------------

## 5. تعدد المستأجرين والعزل

### 5.1 النموذج

**Shared Database + Shared Schema + `tenant_id`**.

في الـ MVP: **مستأجر واحد = شركة واحدة**. يُنشأ سجل `companies` واحد مع كل مستأجر، وتحمل الجداول التشغيلية `tenant_id` و`company_id`. تعدد الشركات لاحقاً لا يحتاج تغيير الجداول.

### 5.2 سياق المستأجر

1. `AuthGuard` يتحقق من Access Token ويستخرج `user_id` و`tenant_id` المختار عند تسجيل الدخول أو التبديل.
2. `TenantGuard` يتحقق من وجود عضوية فعّالة في `tenant_memberships`، ومن أن الاشتراك غير موقوف، ثم يضع القيم في CLS.
3. `BranchGuard` (عند الحاجة) يتحقق من صلاحية المستخدم على الفرع المطلوب.
4. أي خدمة تقرأ السياق من CLS، ولا تقرأه من جسم الطلب.

### 5.3 الحماية التلقائية في Prisma

- يُبنى **Prisma Client Extension** (`tenantScopedPrisma`) يحقن شرط `tenantId` تلقائياً في عمليات `findMany`، `findFirst`، `findUnique`، `count`، `aggregate`، `groupBy`، `update`، `updateMany`، `delete`، `deleteMany`، ويضيفه تلقائياً في `create` و`createMany` و`upsert` للنماذج متعددة المستأجرين.
- قائمة النماذج متعددة المستأجرين معرّفة في مكان واحد. النماذج العامة (مثل `countries`، `currencies`، `plans`) مستثناة صراحة.
- إذا استُدعي نموذج متعدد المستأجرين دون سياق مستأجر، يُرمى خطأ ولا يُنفذ الاستعلام.
- **الاستعلامات الخام (`$queryRaw`) لا تمر عبر الامتداد**، لذا يجب أن تتضمن `tenant_id` يدوياً، ويُراجع كل استعلام خام في الكود.
- عميل Prisma غير المقيد (`systemPrisma`) يُستخدم فقط في وحدة المنصة والمهام المجدولة، ويُوسم استخدامه بتعليق واضح.

### 5.4 منع الربط العرضي بين المستأجرين

- كل جدول متعدد المستأجرين عليه `@@unique([tenantId, id])`.
- العلاقات بين جداول المستأجر نفسه تستخدم مفاتيح خارجية مركبة:
  `@relation(fields: [tenantId, customerId], references: [tenantId, id])`
  بهذا تمنع قاعدة البيانات نفسها ربط فاتورة شركة A بعميل شركة B.
- الفهارس تبدأ بـ `tenant_id`.

### 5.5 اختبارات العزل الإلزامية

تُنشأ بيانات اختبار لمستأجرين A وB، ويُختبر آلياً لكل endpoint رئيسي:

- مستخدم A لا يقرأ ولا يعدّل ولا يحذف ولا يرحّل سجلات B، حتى لو عرف معرفاتها.
- إنشاء مستند في A يشير إلى عميل أو صنف أو حساب من B يفشل.
- التقارير لا تتضمن أي بيانات من B.
- المحاولات المرفوضة تُسجل في `audit_logs`.

------------------------------------------------------------------------

## 6. معايير قاعدة البيانات

### 6.1 التسمية

- الجداول والأعمدة في قاعدة البيانات `snake_case` عبر `@@map` و`@map`، والنماذج والحقول في TypeScript `PascalCase` و`camelCase`.
- لا أسماء عامة مثل `date` أو `type` أو `name` دون سياق: `document_date`، `movement_type`، `name_ar`، `name_en`.
- الأسماء القابلة للترجمة: `name_ar` و`name_en`.

### 6.2 أنواع البيانات

| الاستخدام | النوع |
|---|---|
| المبالغ المحفوظة في المستندات والقيود | `DECIMAL(18,3)` |
| الكميات | `DECIMAL(18,6)` |
| تكلفة الوحدة ومتوسط التكلفة | `DECIMAL(18,6)` |
| سعر الصرف | `DECIMAL(18,8)` |
| النسب (ضريبة، خصم) | `DECIMAL(9,4)` |
| المعرفات | `BIGINT UNSIGNED AUTO_INCREMENT` |
| التواريخ التجارية (تاريخ المستند/الترحيل) | `DATE` |
| الطوابع الزمنية | `DATETIME(3)` بتوقيت UTC |
| الحالات | enum في Prisma |

ممنوع `FLOAT` و`DOUBLE` لأي مبلغ أو كمية.

> ملاحظة: إذا احتاج عميل لاحقاً عملة بدقة أكبر من 3 خانات، يُعاد النظر في دقة الأعمدة عبر migration. دقة 3 تغطي الدينار الأردني.

### 6.3 المعرفات وBigInt

- المعرفات `BigInt` في Prisma.
- **في API تُرسل جميع المعرفات كنصوص (string)**، وتُستقبل كنصوص وتحوّل إلى BigInt في طبقة DTO.
- **جميع المبالغ والكميات تُرسل في API كنصوص** (مثل `"37.120"`)، ولا تُحوّل إلى `number` في أي مكان في الخادم.
- يوجد Interceptor عام يحوّل `BigInt` و`Decimal` إلى string في الاستجابات، مع اختبار يضمن عدم فشل `JSON.stringify`.

### 6.4 التقريب

- الحسابات الوسيطة بدقة كاملة باستخدام `Decimal`.
- مبلغ كل سطر يُقرّب إلى 3 خانات (`ROUND_HALF_UP`) بعد الخصم، ثم تُحسب ضريبة السطر وتُقرّب إلى 3 خانات.
- مجاميع المستند = مجموع الأسطر المقرّبة.
- تُراجع قاعدة تقريب الضريبة (على مستوى السطر أم المستند) مقابل مواصفات JoFotara الرسمية قبل المرحلة 5، وتُوثق في `docs/decisions/`.
- أي فرق تقريب في قيد آلي يُرحّل إلى حساب "فروقات التقريب" من `account_mappings`، ولا يُترك القيد غير متوازن.

### 6.5 الوقت والتاريخ

- الطوابع الزمنية تُخزن UTC.
- التاريخ التجاري الافتراضي للمستند هو "اليوم" بتوقيت الشركة (`Asia/Amman` افتراضياً، قابل للإعداد).
- تُحسب حدود الفترات المالية بالتاريخ التجاري وليس بالطابع الزمني.

### 6.6 الحقول القياسية

الجداول التشغيلية تتضمن: `id`، `tenant_id`، `created_at`، `created_by`، `updated_at`، `updated_by`.
المستندات تتضمن أيضاً حسب نوعها: `company_id`، `branch_id`، `document_no`، `document_date`، `posting_date`، `status`، `currency_id`، `exchange_rate`، `subtotal`، `discount_total`، `tax_total`، `grand_total`، `notes`، `posted_at`، `posted_by`، `cancelled_at`، `cancelled_by`، `reversal_of_id`.

### 6.7 الحذف

- المستندات المسودة: حذف فعلي مسموح.
- المستندات المرحّلة والقيود والحركات: لا حذف ولا تعديل، والتصحيح بالعكس.
- البيانات المرجعية المستخدمة (حساب، صنف، عميل): تعطيل (`is_active = false`) وليس حذفاً.

------------------------------------------------------------------------

## 7. قاموس الجداول للـ MVP

> يُثبت الـ ERD النهائي في `schema.prisma` مع كل مرحلة. الجداول المؤجلة غير مذكورة هنا.

### 7.1 المنصة

| الجدول | الغرض | حقول مهمة |
|---|---|---|
| `plans` | باقات الاشتراك (عام) | code, name_ar, name_en, max_users, max_branches, max_warehouses, max_invoices_per_month, price_monthly, price_yearly, is_active |
| `tenants` | المستأجر | name, status (TRIAL, ACTIVE, PAST_DUE, SUSPENDED, CANCELLED), plan_id, trial_ends_at |
| `subscriptions` | سجل الاشتراك | tenant_id, plan_id, period_start, period_end, status, amount, notes |
| `companies` | الشركة القانونية | tenant_id, legal_name_ar, legal_name_en, tax_number, commercial_registration, address, phone, logo_attachment_id, base_currency_id, timezone, costing_method (WEIGHTED_AVERAGE), allow_negative_stock (false), prices_include_tax |
| `branches` | الفروع | tenant_id, company_id, code, name_ar, name_en, address, is_active |
| `users` | حسابات الدخول (عام) | email (unique), password_hash, full_name, locale, is_active, last_login_at |
| `tenant_memberships` | عضوية المستخدم | tenant_id, user_id, role_id, status, default_branch_id |
| `membership_branches` | الفروع المسموحة للعضو | tenant_id, membership_id, branch_id |
| `roles` | الأدوار الجاهزة | code (OWNER, ACCOUNTANT, STOREKEEPER, CASHIER, VIEWER), name_ar, name_en |
| `role_permissions` | صلاحيات كل دور | role_id, permission_code |
| `refresh_tokens` | الجلسات | user_id, token_hash, family_id, expires_at, revoked_at, replaced_by_id, user_agent, ip |
| `audit_logs` | التدقيق | tenant_id, user_id, action, entity_type, entity_id, before_json, after_json, ip, created_at |
| `attachments` | المرفقات | tenant_id, storage_key, file_name, mime_type, size_bytes |
| `idempotency_keys` | منع التكرار | tenant_id, key, endpoint, request_hash, status, response_json, created_at; unique(tenant_id, key) |

> الصلاحيات في الـ MVP تُعرّف في الكود كقائمة ثابتة (`permissions.ts`) وتُربط بالأدوار عبر seed. لا يوجد محرر صلاحيات في الواجهة.

### 7.2 الإعدادات

| الجدول | الغرض |
|---|---|
| `currencies` | العملات (عام)، مع `decimal_places` |
| `countries` | الدول (عام) |
| `units` | وحدات القياس (لكل مستأجر) |
| `tax_categories` | تصنيفات ضريبية لكل مستأجر، مع `rate` و`einvoice_code` |
| `payment_methods` | طرق الدفع |
| `document_sequences` | تسلسل الأرقام: tenant_id, company_id, document_type, fiscal_year_id, prefix, next_number, padding |
| `account_mappings` | ربط الحسابات: tenant_id, company_id, mapping_key, account_id |

مفاتيح `account_mappings` الإلزامية في الـ MVP:
`SALES`، `SALES_RETURNS`، `SALES_DISCOUNTS`، `INVENTORY`، `COGS`، `INVENTORY_ADJUSTMENT`، `OUTPUT_TAX`، `INPUT_TAX`، `CUSTOMERS_CONTROL`، `SUPPLIERS_CONTROL`، `ROUNDING`، `OPENING_BALANCE_EQUITY`، `RETAINED_EARNINGS`.

### 7.3 المحاسبة

| الجدول | الغرض | حقول مهمة |
|---|---|---|
| `fiscal_years` | السنوات المالية | tenant_id, company_id, code, start_date, end_date, status |
| `fiscal_periods` | الفترات الشهرية | fiscal_year_id, period_no, start_date, end_date, status (OPEN, CLOSED), closed_at, closed_by |
| `accounts` | شجرة الحسابات | tenant_id, company_id, code, name_ar, name_en, parent_id, level, account_type (ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE), normal_balance (DEBIT, CREDIT), is_postable, is_control, control_type (CUSTOMERS, SUPPLIERS, CASH, BANK, null), is_active; unique(tenant_id, company_id, code) |
| `journal_entries` | رأس القيد | tenant_id, company_id, branch_id, entry_no, entry_date, fiscal_period_id, source_type, source_id, posting_kind (POST, REVERSAL), status, description, total_debit, total_credit, reversal_of_id, posted_at, posted_by; unique(tenant_id, source_type, source_id, posting_kind) |
| `journal_lines` | تفاصيل القيد | tenant_id, journal_entry_id, line_no, account_id, debit, credit, party_type (CUSTOMER, SUPPLIER, null), party_id, description, branch_id |

> **الحسابات الرقابية:** حسابا العملاء والموردين حسابان رقابيان (`is_control`). كل سطر عليهما يجب أن يحمل `party_type` و`party_id`. كشف حساب العميل يُستخرج من `journal_lines`، فيكون الأستاذ المساعد مطابقاً للأستاذ العام بالتصميم.

### 7.4 المستودعات

| الجدول | الغرض | حقول مهمة |
|---|---|---|
| `item_groups` | المجموعات | tenant_id, code, name_ar, name_en, parent_id |
| `items` | بطاقة الصنف | tenant_id, code, name_ar, name_en, item_group_id, item_kind (STOCK, SERVICE), base_unit_id, tax_category_id, sale_price, purchase_price, min_stock, is_active |
| `item_units` | وحدات الصنف | tenant_id, item_id, unit_id, factor_to_base, is_default_sale, is_default_purchase |
| `item_barcodes` | الباركود | tenant_id, item_id, item_unit_id, barcode; unique(tenant_id, barcode) |
| `warehouses` | المستودعات | tenant_id, company_id, branch_id, code, name_ar, name_en, is_active |
| `stock_movements` | دفتر الحركة (مصدر الحقيقة) | tenant_id, company_id, warehouse_id, item_id, movement_date, movement_type, source_type, source_id, source_line_id, qty_in, qty_out (بالوحدة الأساسية), unit_cost, total_cost, balance_qty_after, avg_cost_after, reversal_of_id, created_at |
| `stock_balances` | إسقاط الكمية لكل مستودع | tenant_id, warehouse_id, item_id, qty_on_hand, last_movement_date; unique(tenant_id, warehouse_id, item_id) |
| `item_costs` | إسقاط التكلفة لكل صنف في الشركة | tenant_id, company_id, item_id, total_qty, total_value, avg_cost, last_movement_date; unique(tenant_id, company_id, item_id) |
| `stock_adjustments` / `_lines` | الاستلام والصرف اليدوي والرصيد الافتتاحي والتسوية | adjustment_type (OPENING, IN, OUT, COUNT_ADJUSTMENT) |
| `stock_transfers` / `_lines` | التحويل بين المستودعات | from_warehouse_id, to_warehouse_id |
| `stock_counts` / `_lines` | الجرد | system_qty, counted_qty, difference_qty، وينتج `stock_adjustment` عند الاعتماد |

> **قرار:** متوسط التكلفة على مستوى **الصنف في الشركة** (وليس لكل مستودع)، لذا لا يغيّر التحويل بين المستودعات التكلفة ولا ينتج قيداً محاسبياً.

### 7.5 الأطراف

| الجدول | حقول مهمة |
|---|---|
| `customers` | tenant_id, code, name_ar, name_en, tax_number, national_id (اختياري حسب متطلبات JoFotara)، phone, address, city, credit_limit, payment_terms_days, is_cash_customer, is_active |
| `suppliers` | tenant_id, code, name_ar, name_en, tax_number, phone, address, payment_terms_days, is_active |

### 7.6 المبيعات

| الجدول | حقول مهمة |
|---|---|
| `sales_invoices` | الحقول القياسية + customer_id, warehouse_id, payment_type (CASH, CREDIT), cash_box_id (للنقدي), due_date, einvoice_status, einvoice_uuid, einvoice_qr |
| `sales_invoice_lines` | line_no, item_id, item_unit_id, qty, qty_base, unit_price, discount_percent, discount_amount, net_amount, tax_category_id, tax_rate, tax_amount, line_total, unit_cost (يُملأ عند الترحيل), cost_total |
| `sales_returns` | الحقول القياسية + original_invoice_id (إلزامي), customer_id, warehouse_id, refund_type (CASH, CREDIT), reason, einvoice_status, einvoice_uuid |
| `sales_return_lines` | original_line_id (إلزامي), qty, ... كما في أسطر الفاتورة |

### 7.7 المشتريات

| الجدول | حقول مهمة |
|---|---|
| `purchase_invoices` | الحقول القياسية + supplier_id, supplier_invoice_no, supplier_invoice_date, warehouse_id, payment_type, cash_box_id, due_date |
| `purchase_invoice_lines` | كأسطر البيع، و`unit_cost` = صافي سعر الشراء بعد الخصم وقبل الضريبة القابلة للاسترداد |
| `purchase_returns` / `_lines` | original_invoice_id و original_line_id إلزاميان |

### 7.8 الخزينة

| الجدول | حقول مهمة |
|---|---|
| `cash_boxes` | tenant_id, branch_id, code, name, account_id, is_active |
| `bank_accounts` | tenant_id, bank_name, account_no_masked, iban_masked, account_id, is_active |
| `receipts` | سند قبض: party_type, party_id, cash_box_id أو bank_account_id, amount, payment_method_id, reference_no |
| `payments` | سند صرف: party_type (SUPPLIER, CUSTOMER, null للمصروف المباشر), party_id, expense_account_id (عند المصروف), cash_box_id أو bank_account_id, amount |
| `cash_transfers` | من صندوق/بنك إلى صندوق/بنك |
| `allocations` | tenant_id, party_type, party_id, from_document_type, from_document_id, to_document_type, to_document_id, amount, allocated_at |

> **قرار:** رصيد الفاتورة المتبقي = `grand_total - مجموع allocations عليها`، ويُحسب ولا يُخزّن كمصدر للحقيقة. يمكن تخزين `paid_amount` كإسقاط يُحدّث داخل المعاملة نفسها.
>
> **قرار:** مرتجع المبيعات أو المشتريات الآجل (`refund_type = CREDIT`) يُخصص تلقائياً على فاتورته الأصلية عند الترحيل، بحدود المتبقي منها. أي زيادة تبقى رصيداً دائناً للطرف قابلاً للتخصيص لاحقاً.

### 7.9 الفوترة الإلكترونية

| الجدول | حقول مهمة |
|---|---|
| `einvoice_settings` | tenant_id, company_id, client_id, secret_encrypted, activity_number / income source sequence (حسب المواصفة), environment (SANDBOX, PRODUCTION), is_enabled |
| `einvoice_submissions` | tenant_id, document_type, document_id, attempt_no, status (PENDING, SENDING, ACCEPTED, REJECTED, FAILED, UNKNOWN), request_payload (دون أسرار), response_code, response_body, uuid, qr_payload, sent_at, completed_at; unique(tenant_id, document_type, document_id, attempt_no) |

------------------------------------------------------------------------

## 8. قواعد المحاسبة

### 8.1 القيد المزدوج

كل قيد مرحّل يحقق `SUM(debit) = SUM(credit)` بالضبط بعد التقريب إلى 3 خانات. يتحقق `PostingService` من ذلك قبل الإدراج، وتتحقق منه الاختبارات بعده.

كل سطر: إما مدين أو دائن، وليس الاثنين، وليس صفرين. لا يرحّل على حساب غير قابل للحركة (`is_postable = false`) أو غير فعّال.

الطرف (عميل أو مورد) يوضع فقط على سطر حساب رقابي (العملاء أو الموردون)، والحساب الرقابي يتطلبه. سطر عليه طرف وحسابه غير رقابي يُرفض عند الترحيل (قرار D-2، ADR-014)، فيتطابق كشف الطرف والأعمار والحساب الرقابي.

### 8.2 حالات المستند

`DRAFT` ← `POSTED`. لا توجد حالة `REVERSED` مخزنة: المستند أو القيد «معكوس» إذا وُجد قيد عكسي (`posting_kind = REVERSAL`) يشير إليه بـ `reversal_of_id`، والقيد الفريد `(tenant_id, reversal_of_id)` يمنع عكسه مرتين (قرار D-1، ADR-014).
لا توجد حالة `APPROVED` منفصلة في الـ MVP.

### 8.3 العكس

- العكس ينشئ قيداً جديداً `posting_kind = REVERSAL` بنفس الأسطر مع تبديل المدين والدائن، و`reversal_of_id` يشير إلى الأصل.
- تاريخ القيد العكسي = تاريخ العكس (وليس تاريخ الأصل)، ويجب أن يقع في فترة مفتوحة، ولا يسبق تاريخ القيد الأصلي.
- عكس مستند له أثر مخزني يعكس الحركات المخزنية أيضاً بنفس التكلفة الأصلية (القسم 9.5).
- لا يُعكس مستند خصصت عليه مقبوضات أو مدفوعات قبل إلغاء التخصيص.
- لا يُعكس مستند مُرسل إلى JoFotara ومقبول؛ يُستخدم المرتجع بدلاً من ذلك.

### 8.4 القيود الآلية للمستندات (الضريبة غير المضمنة في السعر)

**فاتورة بيع آجلة:**

| الحساب | مدين | دائن |
|---|---|---|
| العملاء (مع party) | grand_total | |
| المبيعات | | net_total |
| ضريبة المبيعات | | tax_total |
| تكلفة البضاعة المباعة | cost_total | |
| المخزون | | cost_total |

**فاتورة بيع نقدية:** نفسها، لكن المدين الأول هو حساب الصندوق المحدد بدل العملاء.
> **قرار:** الخصم في الـ MVP على مستوى السطر فقط، ويُطرح من سعر البيع قبل الضريبة، فلا يظهر حساب خصومات منفصل. (حساب `SALES_DISCOUNTS` محجوز لخصم مستوى الفاتورة لاحقاً.)

**مرتجع مبيعات:** عكس فاتورة البيع، مع استخدام `SALES_RETURNS` بدل `SALES`، وبتكلفة السطر الأصلي.

**فاتورة شراء آجلة:**

| الحساب | مدين | دائن |
|---|---|---|
| المخزون (للأصناف المخزنية) أو حساب مصروف (للخدمات) | net_total | |
| ضريبة المشتريات | tax_total | |
| الموردون (مع party) | | grand_total |

**مرتجع مشتريات:** عكس فاتورة الشراء بتكلفة السطر الأصلي (القسم 9.5).

**سند قبض من عميل:** مدين الصندوق/البنك، دائن العملاء (مع party).
**سند صرف لمورد:** مدين الموردين (مع party)، دائن الصندوق/البنك.
**سند صرف مصروف:** مدين حساب المصروف، دائن الصندوق/البنك.
**تحويل:** مدين الصندوق/البنك الوجهة، دائن المصدر.
**تسوية مخزنية بالزيادة/النقص:** المخزون مقابل `INVENTORY_ADJUSTMENT`.
**رصيد مخزون افتتاحي:** مدين المخزون، دائن `OPENING_BALANCE_EQUITY`.

> إذا كانت الشركة تستخدم أسعاراً شاملة الضريبة (`prices_include_tax`)، يُستخرج صافي السعر من السعر الشامل في الخادم أولاً، ثم تُطبق القيود نفسها.

### 8.5 الفترات المالية

- السنة المالية تُقسم إلى فترات شهرية تلقائياً عند إنشائها، وطولها 12 شهراً على الأكثر، ولا تتداخل مع سنة أخرى للشركة.
- الترحيل يقرأ حالة فترته بقفل مشترك حتى نهاية معاملته، والإغلاق يقفل الفترة قفلاً حصرياً، فلا يُرحَّل شيء في فترة بعد إغلاقها (ADR-014).
- لا يُرحّل أي مستند أو قيد بتاريخ في فترة مغلقة أو خارج سنة مالية موجودة.
- إغلاق وفتح الفترة بصلاحية `fiscal_period.close` فقط، ويُسجل في `audit_logs`.
- الميزانية العمومية في الـ MVP تحسب ربح السنة الحالية ديناميكياً (الإيرادات − المصروفات) وتعرضه ضمن حقوق الملكية، دون قيد إقفال.

### 8.6 الأرصدة الافتتاحية

- **الحسابات:** قيد افتتاحي من نوع `OPENING` بتاريخ بداية السنة المالية بالضبط، والفرق يذهب إلى `OPENING_BALANCE_EQUITY`. الشركة التي تبدأ منتصف السنة تنشئ سنة مالية تبدأ بتاريخ انطلاقها (قرار D-3).
- **العملاء والموردون:** أسطر على الحسابات الرقابية مع `party_id` لكل طرف، ضمن القيد الافتتاحي.
- **المخزون:** `stock_adjustment` من نوع `OPENING` بالكمية وتكلفة الوحدة، ينتج حركة وقيداً.
- يجب أن يطابق رصيد حساب المخزون في القيد الافتتاحي قيمة المخزون الافتتاحي. إذا أُدخل المخزون عبر التسوية الافتتاحية فلا يُدخل رصيد حساب المخزون يدوياً، ويمنع النظام ذلك أو يحذر منه.

### 8.7 شجرة الحسابات الجاهزة (قالب أولي يراجعه محاسب)

```text
1      الأصول
11       الأصول المتداولة
1101       الصندوق                      (CASH)
1102       البنوك                       (BANK)
1103       العملاء                      (رقابي CUSTOMERS)
1104       المخزون
1105       ضريبة المشتريات
12       الأصول الثابتة
1201       الأثاث والمعدات
1202       مجمع الاستهلاك               (رصيد طبيعي دائن)
2      الخصوم
21       الخصوم المتداولة
2101       الموردون                     (رقابي SUPPLIERS)
2102       ضريبة المبيعات
2103       مصاريف مستحقة
3      حقوق الملكية
3101     رأس المال
3102     الأرباح المدورة
3103     أرصدة افتتاحية
4      الإيرادات
4101     المبيعات
4102     مردودات المبيعات               (رصيد طبيعي مدين)
4103     خصم المبيعات                   (رصيد طبيعي مدين)
4201     إيرادات أخرى
5      المصروفات
5101     تكلفة البضاعة المباعة
5102     فروقات الجرد والتسويات
5201     الرواتب
5202     الإيجار
5203     الكهرباء والمياه والاتصالات
5204     مصاريف عمومية وإدارية
5205     فروقات التقريب
```

يُنشأ القالب مع ربطه بمفاتيح `account_mappings` تلقائياً عند إنشاء الشركة، ويستطيع المستخدم تعديله قبل أول ترحيل.

قواعد الشجرة والربط (ADR-014):
- لكل حساب في القالب اسم عربي وإنجليزي.
- الحساب الفرعي يرث نوع أبيه. لا يُضاف فرع تحت حساب عليه قيود، أو مربوط بمفتاح، أو رقابي أو نقدي.
- لا يُعطَّل حساب له رصيد أو قيود مسودة.
- لكل مفتاح ربط نوع حساب مسموح، والمفاتيح الرقابية (`CUSTOMERS_CONTROL`، `SUPPLIERS_CONTROL`) تشترط حساباً رقابياً من النوع نفسه.
- مفاتيح الرقابة والمخزون والبضاعة المستلمة غير المفوترة لا تتغير بعد ترحيل قيود على حسابها الحالي.

------------------------------------------------------------------------

## 9. قواعد المخزون والتكلفة

### 9.1 دفتر الحركة

- `stock_movements` هو مصدر الحقيقة. `stock_balances` و`item_costs` إسقاطات تُحدّث داخل معاملة الترحيل نفسها.
- الكميات في الحركة دائماً بالوحدة الأساسية للصنف: `qty_base = qty × factor_to_base`.
- الأصناف الخدمية (`SERVICE`) لا تنتج حركات مخزنية.
- يوجد أمر/endpoint تحقق (`stock:verify`) يعيد احتساب الأرصدة من الحركات ويقارنها بالإسقاطات، ويُشغّل في الاختبارات وبشكل دوري.

### 9.2 المتوسط المرجح المتحرك

الحالة لكل صنف في الشركة: `total_qty` و`total_value`.

- **حركة دخول** (شراء، رصيد افتتاحي، تسوية زيادة):
  `total_qty += qty_in`
  `total_value += round3(qty_in × unit_cost)`
  `avg_cost = round6(total_value / total_qty)`

- **حركة خروج** (بيع، تسوية نقص):
  `unit_cost = avg_cost`
  إذا كانت `qty_out = total_qty` (يخرج كل الرصيد): `total_cost = total_value` (تخرج القيمة المتبقية كاملة لتجنب بقايا التقريب)
  وإلا: `total_cost = round3(qty_out × avg_cost)`
  `total_qty -= qty_out` و `total_value -= total_cost`
  ويبقى `avg_cost` كما هو (أو يصبح صفراً عند نفاد الكمية).

- **تحويل بين المستودعات:** خروج من المصدر ودخول للوجهة بنفس `avg_cost` الحالي، فلا يتغير `item_costs`، وتتغير `stock_balances` للمستودعين فقط.

### 9.3 المخزون السالب

- الافتراضي: ممنوع. أي حركة خروج تجعل `stock_balances.qty_on_hand` لمستودع أقل من صفر تُرفض برسالة واضحة تذكر الصنف والمستودع والرصيد المتاح.
- `allow_negative_stock` إعداد للشركة، لكنه **غير قابل للتفعيل في واجهة الـ MVP**. يبقى الحقل في الجدول للمستقبل.

### 9.4 قاعدة التاريخ السابق (Backdating)

لا يُرحّل مستند له أثر مخزني إذا كان `posting_date` **أقدم** من `item_costs.last_movement_date` لأي صنف مخزني في المستند.

- الرسالة: "لا يمكن ترحيل هذا المستند بتاريخ {date} لأن الصنف {item} لديه حركات مرحّلة بتاريخ لاحق ({last_date})."
- المستندات بنفس التاريخ مسموحة، وتُرتب الحركات حسب `movement_date` ثم `id`.
- القيود المحاسبية اليدوية وسندات القبض والصرف (دون أثر مخزني) تخضع لقيد الفترة المغلقة فقط.
- الحل الأشمل (إعادة تكلفة بأثر رجعي) مؤجل ويُوثق كقرار في `docs/decisions/`.

### 9.5 تكلفة المرتجعات والعكس

- **مرتجع المبيعات:** يدخل بتكلفة الوحدة المحفوظة في سطر الفاتورة الأصلية (`unit_cost`)، كحركة دخول عادية تعيد احتساب المتوسط.
- **مرتجع المشتريات:** يخرج بتكلفة سطر الشراء الأصلي. إذا كان الرصيد غير كافٍ يُرفض. إذا أدى إلى `total_qty = 0` تُرحّل أي قيمة متبقية في `total_value` إلى `INVENTORY_ADJUSTMENT`.
- **الكمية المرتجعة** لا تتجاوز الكمية الأصلية ناقص ما سبق إرجاعه من السطر نفسه.
- **عكس مستند مرحّل:** ينشئ حركات معاكسة بنفس `unit_cost` و`total_cost` الأصليين، ويخضع لقاعدة التاريخ السابق نفسها بتاريخ العكس.

### 9.6 الجرد

- إنشاء جرد يلتقط `system_qty` لكل صنف في المستودع لحظة البدء.
- يُدخل المستخدم `counted_qty`.
- الاعتماد ينتج `stock_adjustment` من نوع `COUNT_ADJUSTMENT` بالفروقات فقط، يمر بالترحيل العادي.
- لا يعدّل الجرد الأرصدة مباشرة أبداً.

------------------------------------------------------------------------

## 10. دورة الترحيل

### 10.1 الخطوات

```text
 1. Authenticate (AuthGuard)
 2. Resolve tenant/branch from membership (TenantGuard, BranchGuard) → CLS
 3. Check subscription status (not SUSPENDED/CANCELLED) and plan limits
 4. Check permission (e.g. sales_invoice.post)
 5. Check Idempotency-Key (header, required on all /post and /reverse endpoints)
 6. BEGIN interactive transaction (timeout 30s, maxWait 5s)
 7.   SELECT document ... FOR UPDATE           (via $queryRaw, includes tenant_id)
 8.   Verify status = DRAFT
 9.   Validate fiscal period OPEN for posting_date
10.   Validate parties, items, accounts active and same tenant
11.   Recalculate all line amounts, taxes and totals on server; overwrite stored values
12.   SELECT item_costs / stock_balances ... FOR UPDATE
        ORDER BY item_id ASC, warehouse_id ASC  (fixed lock order prevents deadlocks)
13.   Validate backdating rule and negative stock
14.   Allocate document_no from document_sequences (SELECT ... FOR UPDATE)
15.   StockLedgerService: create movements, update balances and costs, return line costs
16.   PostingService: build journal lines, verify balance, insert entry and lines
17.   Update document: status=POSTED, document_no, posted_at, posted_by, line costs
18.   If e-invoicing enabled and document is a sales invoice/return:
        insert einvoice_submissions row with status PENDING (outbox)
19.   Write audit log
20.   Store idempotency response
21. COMMIT
```

أي خطأ قبل `COMMIT` يؤدي إلى `ROLLBACK` كامل، ولا يُمنح رقم مستند ولا تُنشأ حركة أو قيد.

### 10.2 ملاحظات Prisma

- القفل يتم عبر `tx.$queryRaw` بصيغة `SELECT ... FOR UPDATE`، ويجب أن يتضمن `tenant_id` في الشرط.
- استخدم `prisma.$transaction(async (tx) => {...}, { timeout: 30000, maxWait: 5000 })`.
- لا تُستدعى خدمات خارجية (JoFotara، البريد) داخل المعاملة. يُكتب سجل outbox فقط.
- عند خطأ deadlock أو lock wait timeout من MariaDB، يُعاد تنفيذ المعاملة كاملة مرة واحدة تلقائياً قبل إرجاع خطأ للمستخدم.

### 10.3 منع التكرار

1. `Idempotency-Key` إلزامي في طلبات الترحيل والعكس. إعادة الطلب بنفس المفتاح ونفس المحتوى تعيد الاستجابة المحفوظة. بنفس المفتاح ومحتوى مختلف ترجع `409`.
2. قيد فريد `(tenant_id, source_type, source_id, posting_kind)` على `journal_entries`.
3. التحقق من الحالة `DRAFT` بعد القفل.
4. الواجهة تعطّل زر الترحيل أثناء الطلب وتولّد مفتاحاً جديداً لكل محاولة مقصودة.

### 10.4 اختبار التزامن الإلزامي

- طلبان متزامنان لترحيل الفاتورة نفسها: واحد ينجح، والآخر يفشل أو يعيد النتيجة نفسها، ويوجد قيد واحد وحركة واحدة لكل سطر.
- فاتورتان متزامنتان على الصنف نفسه برصيد يكفي واحدة فقط: واحدة تنجح، والأخرى تُرفض بخطأ رصيد غير كافٍ.
- فاتورتان بأصناف متداخلة بترتيب معاكس: لا deadlock دائم، وكلتاهما تنجحان أو تُرفض إحداهما برسالة واضحة.

------------------------------------------------------------------------

## 11. ترقيم المستندات

- **المسودة لا تحمل رقماً رسمياً.** تُعرض بمعرفها الداخلي أو بعبارة "مسودة".
- الرقم يُمنح عند الترحيل من `document_sequences` داخل معاملة الترحيل، مع قفل الصف.
- بما أن منح الرقم يحدث داخل المعاملة نفسها، فإن فشل الترحيل لا يستهلك رقماً، **وتكون أرقام المستندات المرحّلة متسلسلة بلا فجوات**.
- الصيغة الافتراضية: `{PREFIX}-{YYYY}-{NNNNNN}`، مثل `SI-2026-000123`.
- التسلسل لكل `(tenant_id, company_id, document_type, fiscal_year_id)`.
- البادئات الافتراضية: `SI` فاتورة بيع، `SR` مرتجع بيع، `PI` فاتورة شراء، `PR` مرتجع شراء، `RV` سند قبض، `PV` سند صرف، `CT` تحويل نقدي، `JV` قيد يدوي، `ST` تحويل مخزني، `SA` تسوية مخزنية.
- تُراجع متطلبات JoFotara بخصوص أرقام الفواتير والتسلسل قبل المرحلة 7.

------------------------------------------------------------------------

## 12. تكامل JoFotara

> **يجب الرجوع إلى أحدث وثائق JoFotara الرسمية من دائرة ضريبة الدخل والمبيعات قبل كتابة هذه الوحدة.** ما يلي تصميم معماري، وتفاصيل الصيغة والحقول والـ endpoints تُؤخذ من المواصفة الرسمية السارية فقط، وتُوثق في `docs/decisions/` مع رقم إصدار المواصفة.

### 12.1 نموذج البيانات من البداية

من المرحلة 5، يجب أن تتضمن الفواتير والمرتجعات والأطراف كل الحقول التي تحتاجها المواصفة، حتى لو لم يُرسل شيء بعد. يُنشأ في المرحلة 5 ملف `docs/decisions/0005-jofotara-fields.md` يربط كل حقل مطلوب في المواصفة بعمود في قاعدة البيانات.

### 12.2 الإرسال عبر Outbox

```text
Post invoice (transaction) → einvoice_submissions(status=PENDING)
                                     │
Cron (every minute) → einvoice job:
   1. Claim PENDING rows with SELECT ... FOR UPDATE SKIP LOCKED (if supported by DB version)
      or by atomic UPDATE status=SENDING WHERE status=PENDING
   2. Build payload from posted document (never from client data)
   3. Validate payload (schema, totals, tax) before sending
   4. Send
   5. Save response:
        - success       → ACCEPTED, save uuid, qr_payload; update invoice einvoice_status
        - validation err→ REJECTED, save errors; notify user; no auto-retry
        - network/5xx   → FAILED, retry with backoff (max 5 attempts)
        - timeout with unknown outcome → UNKNOWN; do not resend automatically
```

- **حالة `UNKNOWN`** تعني أن الطلب ربما وصل. لا يُعاد الإرسال تلقائياً. إذا كانت المواصفة توفر طريقة للاستعلام عن الفاتورة، يُستخدم ذلك قبل أي إعادة، وإلا يُعرض للمستخدم كحالة تحتاج مراجعة يدوية.
- الفاتورة المقبولة لا تُعكس؛ يُستخدم المرتجع المرتبط.
- المرتجع يُرسل بعد قبول فاتورته الأصلية فقط.

### 12.3 الأمان

- `secret` الخاص بكل شركة يُشفّر بـ AES-256-GCM بمفتاح من متغير بيئة (`EINVOICE_ENC_KEY`)، ولا يُخزن مفتوحاً.
- لا تُسجّل بيانات الاعتماد أو الترويسات الحساسة في `integration logs` أو `request_payload`.
- بيئة SANDBOX وPRODUCTION منفصلتان في الإعدادات، والانتقال إلى PRODUCTION بصلاحية المالك فقط.

### 12.4 الطباعة

قالب طباعة الفاتورة يعرض رمز QR المستلم من JoFotara. الفاتورة غير المقبولة بعد تُطبع بعلامة واضحة تبين حالتها.

------------------------------------------------------------------------

## 13. الجوانب التجارية (SaaS)

### 13.1 الباقات والحدود

- `plans` تُعرّف عبر seed. الحدود في الـ MVP: عدد المستخدمين، الفروع، المستودعات، والفواتير الشهرية.
- خدمة `PlanLimitsService` تُستدعى قبل إنشاء مستخدم أو فرع أو مستودع، وقبل ترحيل فاتورة، وتُرجع خطأ `402` برسالة واضحة عند تجاوز الحد.

### 13.2 دورة حياة المستأجر

| الحالة | السلوك |
|---|---|
| `TRIAL` | كل الميزات، لمدة محددة (افتراضياً 14 يوماً) |
| `ACTIVE` | حسب الباقة |
| `PAST_DUE` | تحذير في الواجهة، كل الميزات تعمل لفترة سماح (افتراضياً 7 أيام) |
| `SUSPENDED` | **وضع القراءة فقط**: يمكن الدخول والعرض والطباعة والتصدير، ويُمنع الإنشاء والترحيل |
| `CANCELLED` | يمكن تصدير البيانات فقط لفترة محددة، ثم تُحذف وفق سياسة معلنة |

- مهمة يومية مجدولة تنقل الحالات حسب التواريخ.
- **الدفع في الـ MVP يدوي** (تحويل بنكي أو CliQ)، ويُفعّل الاشتراك من لوحة إدارة المنصة. بوابة الدفع الآلي مؤجلة.

### 13.3 لوحة إدارة المنصة (Super Admin)

واجهة بسيطة ومحمية لمالك المنصة فقط: قائمة المستأجرين، الحالة، الباقة، تمديد الاشتراك، تسجيل دفعة، تعليق حساب. لا تعرض البيانات المالية الداخلية للمستأجرين.

### 13.4 معالج الإعداد

1. بيانات الشركة: الاسم، الرقم الضريبي، العنوان، الشعار.
2. السنة المالية: تاريخ البداية (افتراضياً 1 يناير).
3. الضريبة: هل الشركة مسجلة؟ هل الأسعار شاملة الضريبة؟ النسب المستخدمة.
4. شجرة الحسابات: استخدام القالب الجاهز (القسم 8.7).
5. الفرع الرئيسي والمستودع الرئيسي والصندوق الرئيسي.
6. دعوة المستخدمين (اختياري).
7. الاستيراد (اختياري، ويمكن العودة إليه).

### 13.5 الاستيراد من Excel

قوالب Excel قابلة للتنزيل لكل من: الأصناف، العملاء، الموردين، أرصدة الحسابات الافتتاحية، أرصدة العملاء والموردين الافتتاحية، أرصدة المخزون الافتتاحية.

- يمر الاستيراد بمرحلة **معاينة وتحقق** تعرض الأخطاء لكل صف قبل الحفظ.
- الحفظ في معاملة واحدة: إما ينجح الملف كله أو لا شيء.
- الأرصدة الافتتاحية تنتج مستندات مسودة، ثم يُرحّلها المستخدم.

### 13.6 تصدير بيانات المستأجر

ملف ZIP يحتوي ملفات Excel لكل البيانات الرئيسية (الحسابات، القيود، الأصناف، الحركات، الأطراف، المستندات). متاح للمالك في كل الحالات بما فيها `SUSPENDED` و`CANCELLED`.

### 13.7 قوالب الطباعة

PDF عربي RTL (وإنجليزي اختياري) لـ: فاتورة البيع، المرتجع، فاتورة الشراء، سند القبض، سند الصرف، كشف الحساب. تتضمن الشعار وبيانات الشركة والرقم الضريبي ورمز QR للفاتورة الإلكترونية.

### 13.8 حماية البيانات

تُراجع متطلبات قانون حماية البيانات الشخصية الأردني قبل الإطلاق، وتُعد سياسة خصوصية وشروط استخدام واتفاقية معالجة بيانات بمساعدة مختص قانوني.

------------------------------------------------------------------------

## 14. الأمان

1. كلمات المرور: Argon2id بإعدادات موصى بها.
2. Access Token مدته 15 دقيقة. Refresh Token مدته 30 يوماً، دوّار، مخزن كـ hash، مع كشف إعادة الاستخدام (عند إعادة استخدام token ملغى تُلغى عائلته كاملة).
3. الويب: Refresh Token في cookie من نوع `httpOnly` و`Secure` و`SameSite=Strict` على مسار `/api/v1/auth`. Access Token في الذاكرة فقط وليس في localStorage.
4. CSRF: بما أن الـ cookie مقيّد بـ SameSite=Strict ومسار المصادقة فقط، وباقي الطلبات تستخدم ترويسة Authorization، يكفي ذلك في الـ MVP. يُوثق القرار.
5. Rate limiting (`@nestjs/throttler`) على تسجيل الدخول واستعادة كلمة المرور والترحيل.
6. التحقق من كل المدخلات في Backend عبر DTO مع `whitelist: true` و`forbidNonWhitelisted: true`.
7. ترويسات الأمان عبر `helmet`، وCORS مقيّد بنطاق الواجهة.
8. الأسرار في متغيرات البيئة فقط، و`.env` في `.gitignore`، و`.env.example` دون قيم حقيقية.
9. لا تُسجّل كلمات المرور والـ tokens وبيانات JoFotara في السجلات.
10. نسخ احتياطي يومي لقاعدة البيانات والمرفقات، مع اختبار استعادة شهري موثق.
11. مراجعة أمنية لعزل المستأجرين قبل الإطلاق التجريبي.

------------------------------------------------------------------------

## 15. API

- البادئة `/api/v1`، بصيغة JSON، وموثقة بـ Swagger على `/api/docs` (محمية في الإنتاج).
- المعرفات والمبالغ والكميات كنصوص (القسم 6.3).
- صيغة الخطأ الموحدة:

```json
{
  "error": {
    "code": "STOCK_INSUFFICIENT",
    "message": "الرصيد غير كافٍ للصنف ITEM-001 في المستودع الرئيسي",
    "details": { "itemId": "15", "warehouseId": "2", "available": "3.000000", "requested": "5.000000" },
    "requestId": "..."
  }
}
```

- رموز الأخطاء معرّفة كـ enum في الكود ومترجمة في الواجهة.
- الترقيم الصفحي: `?page=1&pageSize=25`، والاستجابة `{ data, meta: { page, pageSize, total } }`.
- الترحيل والعكس عبر مسارات أفعال صريحة: `POST /sales-invoices/:id/post` و`POST /sales-invoices/:id/reverse`.

مسارات أساسية:

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
GET    /api/v1/me
GET    /api/v1/me/tenants
POST   /api/v1/me/switch-tenant

GET|POST|PATCH        /api/v1/branches
GET|POST|PATCH        /api/v1/warehouses
GET|POST|PATCH        /api/v1/accounts
GET|POST              /api/v1/fiscal-years
POST                  /api/v1/fiscal-periods/:id/close
POST                  /api/v1/fiscal-periods/:id/reopen
GET|POST|PATCH|DELETE /api/v1/journal-entries        (DELETE للمسودة فقط)
POST                  /api/v1/journal-entries/:id/post
POST                  /api/v1/journal-entries/:id/reverse

GET|POST|PATCH        /api/v1/items
GET                   /api/v1/items/by-barcode/:barcode
GET|POST|PATCH|DELETE /api/v1/stock-adjustments
POST                  /api/v1/stock-adjustments/:id/post
GET|POST|PATCH|DELETE /api/v1/stock-transfers
POST                  /api/v1/stock-transfers/:id/post
GET|POST|PATCH        /api/v1/stock-counts
POST                  /api/v1/stock-counts/:id/approve

GET|POST|PATCH        /api/v1/customers
GET|POST|PATCH        /api/v1/suppliers
GET|POST|PATCH|DELETE /api/v1/sales-invoices
POST                  /api/v1/sales-invoices/:id/post
POST                  /api/v1/sales-invoices/:id/reverse
GET                   /api/v1/sales-invoices/:id/pdf
GET|POST|PATCH|DELETE /api/v1/sales-returns
POST                  /api/v1/sales-returns/:id/post
(وبالمثل purchase-invoices و purchase-returns و receipts و payments و cash-transfers)
POST                  /api/v1/allocations
DELETE                /api/v1/allocations/:id

GET    /api/v1/einvoice/submissions
POST   /api/v1/einvoice/submissions/:id/retry        (للحالات FAILED فقط، وبصلاحية)

GET    /api/v1/reports/trial-balance
GET    /api/v1/reports/general-ledger
GET    /api/v1/reports/party-statement
GET    /api/v1/reports/aging
GET    /api/v1/reports/stock-balance
GET    /api/v1/reports/stock-valuation
GET    /api/v1/reports/item-movement
GET    /api/v1/reports/sales-summary
GET    /api/v1/reports/purchases-summary
GET    /api/v1/reports/tax-summary
GET    /api/v1/reports/income-statement
GET    /api/v1/reports/balance-sheet
(كل تقرير يقبل ?format=json|pdf|xlsx)

GET    /api/v1/import/templates/:type
POST   /api/v1/import/:type/preview
POST   /api/v1/import/:type/commit
POST   /api/v1/export/tenant-data

GET|POST|PATCH /api/v1/admin/tenants              (Super Admin فقط)
POST           /api/v1/admin/tenants/:id/subscriptions
```

------------------------------------------------------------------------

## 16. واجهة الويب

- عربية RTL افتراضياً، وإنجليزية LTR، مع تبديل فوري (`ConfigProvider direction` في Ant Design).
- متجاوبة: كمبيوتر وتابلت بشكل كامل، والجوال لشاشات الاستعراض والبحث بالباركود (كاميرا المتصفح) والفواتير البسيطة.
- كل الجداول تدعم البحث والفرز والترقيم الصفحي من الخادم.
- حالة المستند ظاهرة بلون ثابت: مسودة / مرحّل / معكوس، وحالة JoFotara: بانتظار الإرسال / مقبول / مرفوض / يحتاج مراجعة.
- المستند المرحّل يُعرض للقراءة فقط، مع أزرار الطباعة والعكس والمرتجع حسب الصلاحية.
- منع الإرسال المزدوج للنماذج، وتوليد `Idempotency-Key` لكل ترحيل.
- اختصارات لوحة المفاتيح في شاشة الفاتورة (إضافة سطر، البحث عن صنف، الحفظ، الترحيل).
- الأرقام تُعرض بالأرقام الغربية (0-9) افتراضياً، مع فواصل الآلاف و3 خانات للدينار.

------------------------------------------------------------------------

## 17. المراحل التنفيذية

> القاعدة: لا تبدأ مرحلة قبل اجتياز اختبارات قبول المرحلة السابقة وكتابة تقريرها في `docs/phase-reports/`.
> المدد تقديرية لمطور واحد بدوام كامل، وتختلف حسب الخبرة والوقت المتاح.

### المرحلة 0 — البيئة والأساس (حوالي أسبوع)

**المخرجات:**
- Monorepo بـ pnpm workspaces: `apps/api`، `apps/web`، `packages/api-client`.
- NestJS مع: config بتحقق schema، nestjs-cls، helmet، throttler، swagger، فلتر أخطاء موحد، Interceptor تحويل BigInt/Decimal، `requestId`.
- Prisma متصل بـ MariaDB، مع migration تجريبية.
- React + Vite + Ant Design + i18n + RTL + TanStack Query.
- توليد `api-client` من OpenAPI بأمر واحد.
- ESLint + Prettier + TypeScript strict.
- Jest مع قاعدة بيانات اختبار، وVitest للويب.
- GitHub Actions: lint، typecheck، test.
- `.env.example`، `README.md` بأوامر التشغيل، `CLAUDE.md`.
- endpoint `GET /api/v1/health` يتحقق من اتصال قاعدة البيانات.
- نشر تجريبي على Hostinger.

**اختبارات القبول:**
- [ ] `pnpm install && pnpm dev` يشغل الـ API والويب محلياً.
- [ ] `/api/v1/health` يعمل محلياً وعلى Hostinger.
- [ ] الويب يعرض نتيجة health من الـ API بالعربية وRTL.
- [ ] migration تُطبق على قاعدة اختبار وقاعدة Hostinger.
- [ ] اختبار يؤكد أن استجابة فيها BigInt وDecimal تُحوّل إلى strings.
- [ ] CI أخضر.
- [ ] لا أسرار في Git.

### المرحلة 1 — المنصة والعزل (حوالي 3 أسابيع)

**المخرجات:** plans، tenants، subscriptions، companies، branches، users، tenant_memberships، membership_branches، roles، role_permissions، refresh_tokens، audit_logs، idempotency_keys. التسجيل (ينشئ مستأجراً بحالة TRIAL + شركة + مستخدماً مالكاً)، الدخول، التحديث، الخروج، التبديل بين المستأجرين، دعوة مستخدم. Guards الثلاثة. Prisma tenant extension. `PlanLimitsService`. حالة القراءة فقط. لوحة Super Admin الأولية. شاشات الدخول والتسجيل والمستخدمين والفروع في الويب.

**اختبارات القبول:**
- [ ] مستخدم A لا يصل إلى أي سجل في B (اختبارات آلية على كل endpoint).
- [ ] المفتاح الخارجي المركب يمنع ربط سجل بسجل من مستأجر آخر على مستوى قاعدة البيانات.
- [ ] استعلام نموذج متعدد المستأجرين دون سياق يرمي خطأ.
- [ ] إعادة استخدام Refresh Token ملغى تلغي عائلته كاملة.
- [ ] تجاوز حد الباقة يرجع 402.
- [ ] المستأجر SUSPENDED يقرأ ولا يكتب.
- [ ] كل عملية حساسة تُسجل في audit_logs.
- [ ] `Idempotency-Key` يعمل وفق القسم 10.3 (اختبار على endpoint تجريبي).

### المرحلة 2 — الإعدادات المالية وشجرة الحسابات (حوالي أسبوعين)

**المخرجات:** currencies (seed)، units، tax_categories، payment_methods، document_sequences، fiscal_years، fiscal_periods، accounts، account_mappings. قالب شجرة الحسابات الجاهزة (8.7) يُنشأ مع الشركة. شاشة شجرة الحسابات (عرض شجري، إضافة، تعديل، تعطيل). شاشة السنوات والفترات.

**اختبارات القبول:**
- [ ] إنشاء شركة جديدة ينشئ الشجرة الجاهزة وكل مفاتيح account_mappings الإلزامية.
- [ ] منع تكرار كود الحساب في الشركة.
- [ ] الحساب الأب غير قابل للحركة.
- [ ] منع تعطيل حساب عليه رصيد أو مستخدم في mapping.
- [ ] إنشاء سنة مالية ينشئ 12 فترة.
- [ ] الإغلاق والفتح بالصلاحية فقط ويُسجلان.

### المرحلة 3 — محرك القيود (حوالي 3 أسابيع)

**المخرجات:** journal_entries، journal_lines، `PostingService`، القيود اليدوية (مسودة، ترحيل، عكس)، القيد الافتتاحي، تقارير الأستاذ العام وميزان المراجعة وكشف حساب الطرف (JSON فقط). شاشات القيود والتقارير.

**اختبارات القبول:**
- [ ] قيد غير متوازن لا يُرحّل.
- [ ] لا ترحيل إلى فترة مغلقة أو تاريخ خارج سنة مالية.
- [ ] لا ترحيل على حساب أب أو غير فعال.
- [ ] سطر على حساب رقابي دون party يُرفض.
- [ ] ترحيل المصدر نفسه مرتين مستحيل (قيد فريد + اختبار تزامن).
- [ ] القيد العكسي مرتبط بالأصل وتاريخه تاريخ العكس.
- [ ] ميزان المراجعة متوازن ويطابق مجموع الأسطر.
- [ ] كشف حساب الطرف يطابق رصيده في الحساب الرقابي.
- [ ] الأرقام مُرحّلة بلا فجوات تحت التزامن.

### المرحلة 4 — الأصناف والمستودعات (حوالي 4 أسابيع)

**المخرجات:** item_groups، items، item_units، item_barcodes، warehouses، stock_movements، stock_balances، item_costs، stock_adjustments (OPENING, IN, OUT, COUNT_ADJUSTMENT)، stock_transfers، stock_counts. `StockLedgerService` بالمتوسط المرجح. قاعدة التاريخ السابق. أمر `stock:verify`. تقارير رصيد المخزون وتقييمه وحركة الصنف. الشاشات.

**اختبارات القبول:**
- [ ] كل السيناريوهات الذهبية للمخزون في القسم 18 تنجح.
- [ ] الرصيد في stock_balances وitem_costs يطابق إعادة الاحتساب من الحركات.
- [ ] التحويل يخصم من المصدر ويضيف للوجهة ولا ينشئ قيداً.
- [ ] المخزون السالب مرفوض.
- [ ] قاعدة التاريخ السابق مطبقة.
- [ ] اختبارات التزامن الثلاثة في 10.4 تنجح.
- [ ] قيمة المخزون في التقييم = رصيد حساب المخزون في ميزان المراجعة.
- [ ] الجرد لا يعدّل الرصيد إلا عبر تسوية مرحّلة.

### المرحلة 5 — الأطراف والمبيعات والمشتريات (حوالي 5 أسابيع)

**قبل البدء:** قراءة مواصفة JoFotara الرسمية وكتابة `docs/decisions/0005-jofotara-fields.md` وقرار التقريب الضريبي.

**المخرجات:** customers، suppliers، sales_invoices، sales_returns، purchase_invoices، purchase_returns وأسطرها. حساب الأسعار والخصم والضريبة في الخادم. الترحيل وفق القسم 10. النقدي والآجل. المرتجع المرتبط بالأصل. الشاشات، مع شاشة فاتورة سريعة الإدخال.

**اختبارات القبول:**
- [ ] كل السيناريوهات الذهبية للمبيعات والمشتريات في القسم 18 تنجح.
- [ ] فاتورة البيع تنتج قيداً واحداً وحركات مخزنية مرة واحدة فقط.
- [ ] المجاميع المرسلة من العميل تُتجاهل ويُعاد حسابها.
- [ ] المرتجع لا يتجاوز الكمية الأصلية ناقص المرتجع السابق.
- [ ] تكلفة مرتجع المبيعات = تكلفة سطر الفاتورة الأصلية.
- [ ] لا يمكن ترحيل فاتورة على فرع غير مصرح للمستخدم.
- [ ] الأصناف الخدمية لا تنتج حركات مخزنية.
- [ ] كل الحقول المطلوبة لـ JoFotara موجودة في الجداول.

### المرحلة 6 — الخزينة (حوالي أسبوعين)

**المخرجات:** cash_boxes، bank_accounts، receipts، payments (لطرف أو مصروف)، cash_transfers، allocations. التخصيص التلقائي على أقدم فاتورة (اختياري) والتخصيص اليدوي. تقرير أعمار الديون. الشاشات.

**اختبارات القبول:**
- [ ] كل سند مرحّل ينشئ قيداً متوازناً مرة واحدة.
- [ ] التخصيص لا يتجاوز المتبقي من الفاتورة ولا المتبقي من السند.
- [ ] الفاتورة النقدية لا تظهر كذمة في أعمار الديون.
- [ ] رصيد الصندوق في التقرير = رصيد حسابه في ميزان المراجعة.
- [ ] لا يُعكس سند عليه تخصيص قبل إلغاء التخصيص.

### المرحلة 7 — JoFotara (حوالي 3 إلى 4 أسابيع)

**المخرجات:** einvoice_settings بتشفير السر، بناء الحمولة وفق المواصفة الرسمية، التحقق قبل الإرسال، Outbox ومهمة Cron، معالجة كل الحالات (12.2)، شاشة متابعة الإرسال، QR في الطباعة. اختبار كامل على بيئة SANDBOX.

**اختبارات القبول:**
- [ ] الحمولة تجتاز التحقق المحلي مقابل المخطط الرسمي.
- [ ] فاتورة بيع ومرتجع يُقبلان في SANDBOX.
- [ ] لا إرسال مزدوج لنفس المستند (حتى مع تشغيل مهمتين متزامنتين).
- [ ] حالة UNKNOWN لا تُعاد تلقائياً.
- [ ] السر لا يظهر في أي سجل أو استجابة API.
- [ ] الرفض يظهر للمستخدم برسالة مفهومة.

### المرحلة 8 — التقارير والطباعة (حوالي 3 أسابيع)

**المخرجات:** كل تقارير القسم 15 بصيغ JSON وPDF وXLSX، قائمة الدخل، الميزانية العمومية (بربح السنة الديناميكي)، ملخص الضريبة، قوالب الطباعة (13.7)، لوحة تحكم مختصرة (مبيعات اليوم/الشهر، الذمم، أصناف تحت الحد الأدنى).

**اختبارات القبول:**
- [ ] كل رقم في التقارير يطابق مصدره في الاختبارات.
- [ ] الميزانية متوازنة: الأصول = الخصوم + حقوق الملكية + ربح السنة.
- [ ] PDF العربي يعرض النص والأرقام والاتجاه بشكل صحيح.
- [ ] التقارير تعمل في زمن مقبول على بيانات اختبار كبيرة (مثلاً 100 ألف سطر قيد، يُثبت الحد الفعلي في الاختبار).
- [ ] لا يظهر أي سجل من مستأجر آخر.

### المرحلة 9 — الجاهزية التجارية (حوالي 3 أسابيع)

**المخرجات:** معالج الإعداد (13.4)، الاستيراد من Excel (13.5)، تصدير بيانات المستأجر (13.6)، مهمة تحويل حالات الاشتراك، إكمال لوحة Super Admin، صفحات سياسة الخصوصية وشروط الاستخدام، دليل مستخدم مختصر بالعربية.

**اختبارات القبول:**
- [ ] مستخدم جديد يكمل الإعداد ويصدر أول فاتورة دون مساعدة (اختبار مع شخص حقيقي).
- [ ] استيراد ملف فيه أخطاء يعرضها كلها ولا يحفظ شيئاً.
- [ ] الأرصدة الافتتاحية المستوردة تُنتج ميزان مراجعة متوازناً.
- [ ] التصدير يعمل في حالة SUSPENDED.
- [ ] انتهاء الفترة التجريبية ينقل الحالة وفق 13.2.

### المرحلة 10 — التجربة والإطلاق (حوالي 4 أسابيع)

**المخرجات:** إعداد الإنتاج والنطاق وSSL، النسخ الاحتياطي اليومي، مراقبة الأخطاء، خطة الاستعادة، 2 إلى 3 شركات تجريبية حقيقية مع محاسب، إصلاح ملاحظاتها، مراجعة أمنية للعزل.

**اختبارات القبول:**
- [ ] استعادة نسخة احتياطية في بيئة اختبار ناجحة وموثقة.
- [ ] كل اختبارات العزل والترحيل والتزامن خضراء على بيئة شبيهة بالإنتاج.
- [ ] الشركات التجريبية أصدرت فواتير حقيقية وأُرسلت إلى JoFotara.
- [ ] المحاسب راجع ميزان المراجعة والتقارير لشركة تجريبية واحدة على الأقل ووافق عليها.

**المجموع التقريبي:** 33 إلى 34 أسبوعاً (قرابة 8 أشهر).

------------------------------------------------------------------------

## 18. السيناريوهات الذهبية للاختبار

> أرقام توضيحية بضريبة 16% غير مضمنة في السعر. تُكتب كاختبارات تكاملية تتحقق من القيود والحركات والأرصدة بالضبط. يراجعها محاسب ويضيف إليها.

**الإعداد:** شركة جديدة، مستودع رئيسي (W1) ومستودع فرعي (W2)، صنف A وحدته الأساسية "قطعة"، تصنيف ضريبي 16%.

### س1 — شراء آجل
فاتورة شراء: 10 قطع من A بسعر 5.000 للمستودع W1.

- الأسطر: net 50.000، ضريبة 8.000، الإجمالي 58.000.
- القيد: مدين المخزون 50.000، مدين ضريبة المشتريات 8.000، دائن الموردون 58.000 (مع المورد).
- item_costs(A): qty 10، value 50.000، avg 5.000000.
- stock_balances(W1, A) = 10.

### س2 — بيع آجل
فاتورة بيع: 4 قطع من A بسعر 8.000 من W1.

- net 32.000، ضريبة 5.120، الإجمالي 37.120.
- التكلفة: 4 × 5.000 = 20.000.
- القيد: مدين العملاء 37.120، دائن المبيعات 32.000، دائن ضريبة المبيعات 5.120، مدين تكلفة البضاعة 20.000، دائن المخزون 20.000.
- item_costs(A): qty 6، value 30.000، avg 5.000000.

### س3 — شراء بسعر مختلف
فاتورة شراء: 10 قطع من A بسعر 6.000.

- item_costs(A): qty 16، value 90.000، avg 5.625000.

### س4 — بيع نقدي بالمتوسط الجديد
بيع نقدي 3 قطع بسعر 9.000 (مدين الصندوق بدل العملاء).

- net 27.000، ضريبة 4.320، الإجمالي 31.320.
- التكلفة: 3 × 5.625 = 16.875.
- item_costs(A): qty 13، value 73.125، avg 5.625000.

### س5 — مرتجع مبيعات من الفاتورة س2
إرجاع قطعة واحدة.

- القيد: مدين مردودات المبيعات 8.000، مدين ضريبة المبيعات 1.280، دائن العملاء 9.280، مدين المخزون 5.000، دائن تكلفة البضاعة 5.000.
- التكلفة بسعر السطر الأصلي 5.000 وليس المتوسط الحالي.
- item_costs(A): qty 14، value 78.125، avg = round6(78.125 / 14) = 5.580357.

### س6 — خروج كامل الرصيد
تسوية نقص بكامل الرصيد الحالي (14 قطعة).

- total_cost = 78.125 بالضبط (كل القيمة المتبقية)، وليس 14 × 5.580357.
- item_costs(A): qty 0، value 0.000.

### س7 — تحويل
بعد شراء 5 قطع جديدة في W1: تحويل 2 من W1 إلى W2.

- stock_balances(W1) ينقص 2، و(W2) يزيد 2.
- item_costs لا يتغير، ولا يُنشأ قيد.

### س8 — المخزون السالب
محاولة بيع 10 قطع من W2 ورصيدها 2: تُرفض بـ `STOCK_INSUFFICIENT`، ولا يُنشأ قيد ولا حركة، ولا يُستهلك رقم فاتورة.

### س9 — التاريخ السابق
محاولة ترحيل فاتورة شراء للصنف A بتاريخ أقدم من آخر حركة له: تُرفض بـ `BACKDATED_STOCK_POSTING`.

### س10 — قبض وتخصيص
سند قبض 20.000 من العميل، يُخصص على فاتورة س2. المتبقي قبل القبض 27.840 (37.120 ناقص المرتجع 9.280 المخصص تلقائياً).

- القيد: مدين الصندوق 20.000، دائن العملاء 20.000.
- المتبقي على الفاتورة 7.840.
- كشف حساب العميل = رصيده في الحساب الرقابي = 7.840.

### س11 — المطابقة النهائية
بعد كل ما سبق:
- ميزان المراجعة متوازن.
- رصيد حساب المخزون = مجموع قيمة item_costs.
- `stock:verify` لا يجد أي فرق.

------------------------------------------------------------------------

## 19. قواعد لا يجوز تجاوزها

1. لا منطق محاسبي أو مخزني أو ضريبي في الواجهة.
2. لا تُقبل مجاميع أو تكاليف من العميل دون إعادة حسابها.
3. لا `FLOAT` أو `DOUBLE` في قاعدة البيانات، ولا `number` في JavaScript لأي مبلغ أو كمية.
4. لا تعديل ولا حذف لمستند أو قيد أو حركة مرحّلة.
5. لا اعتماد على `tenant_id` القادم من العميل.
6. لا أرقام حسابات ثابتة في الكود؛ استخدم `account_mappings`.
7. لا يُنشأ قيد مرحّل إلا عبر `PostingService`، ولا حركة مخزنية إلا عبر `StockLedgerService`.
8. لا ترحيل في أكثر من معاملة واحدة.
9. لا استدعاء لخدمة خارجية داخل معاملة قاعدة البيانات.
10. لا `$queryRaw` على جدول متعدد المستأجرين دون شرط `tenant_id`.
11. لا أسرار في Git ولا في السجلات.
12. لا تغيير يدوي في قاعدة بيانات الإنتاج؛ كل التغييرات عبر migrations.
13. لا انتقال إلى مرحلة قبل اجتياز اختبارات قبول السابقة وكتابة تقريرها.
14. لا تغيير لقرار في هذه الوثيقة دون كتابة ADR في `docs/decisions/` وموافقة المالك.

------------------------------------------------------------------------

## 20. خارطة الطريق بعد الإطلاق (ترتيب مقترح)

1. قيد إقفال السنة الآلي وترحيل الأرباح المدورة.
2. خصم على مستوى الفاتورة.
3. عروض الأسعار وأوامر البيع.
4. التسوية البنكية.
5. مراكز التكلفة.
6. بوابة دفع آلية للاشتراكات.
7. تطبيق Android (React Native / Expo) للاستعراض والباركود.
8. إعادة تكلفة بأثر رجعي (حل بديل لقاعدة التاريخ السابق).
9. تعدد الشركات للمستأجر الواحد.
10. تعدد العملات الفعلي وفروقات الصرف.
11. FIFO والتشغيلات والصلاحية.
12. أوامر الشراء واستلام البضاعة المنفصل.
13. محرر صلاحيات مرن.
14. قائمة التدفقات النقدية.

------------------------------------------------------------------------

## 21. قرارات معلقة يحسمها المالك

| # | القرار | متى يُحسم |
|---|---|---|
| 1 | أسعار الباقات وحدودها | قبل المرحلة 9 |
| 2 | قاعدة تقريب الضريبة (سطر أم مستند) وفق JoFotara | قبل المرحلة 5 |
| 3 | الحقول الإلزامية للعميل في الفاتورة الإلكترونية (الرقم الوطني، الرقم الضريبي، المدينة) | قبل المرحلة 5 |
| 4 | هل تحتاج أول الشركات المستهدفة ضريبة خاصة غير الضريبة العامة | قبل المرحلة 5 |
| 5 | مدة الفترة التجريبية وفترة السماح | قبل المرحلة 9 |
| 6 | مدة الاحتفاظ بالبيانات بعد الإلغاء | قبل المرحلة 9 |
| 7 | اسم المنتج والنطاق | قبل المرحلة 10 |
| 8 | المحاسب المستشار والشركات التجريبية | قبل المرحلة 4 (لمراجعة السيناريوهات الذهبية) |

------------------------------------------------------------------------

## 22. تقرير نهاية كل مرحلة

يُكتب في `docs/phase-reports/phase-N.md` ويتضمن:

1. ما تم إنجازه مقابل المخرجات.
2. الجداول والـ migrations المنشأة.
3. الـ endpoints والشاشات المضافة.
4. نتائج اختبارات القبول (كل بند مع حالته).
5. أوامر التشغيل والنشر الجديدة.
6. المشاكل المعروفة والديون التقنية.
7. القرارات المتخذة (روابط ADR).
8. ما يلزم قبل بدء المرحلة التالية.
