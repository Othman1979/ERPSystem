# Phase 2 — الإعدادات المالية وشجرة الحسابات

**الحالة:** مكتملة ومُتحقق منها
**النطاق:** `countries` (بذور) + `units` + `tax_categories` + `payment_methods` + `document_sequences` + `fiscal_years` + `fiscal_periods` + `accounts` + `account_mappings` + شجرة حسابات جاهزة + فترات مالية + شاشات الويب.

## ما تم بناؤه

### قاعدة البيانات (`apps/api/prisma/schema.prisma`)
- جدول منصة جديد: `countries` (بذور: JO, SA, AE, IQ, EG, US).
- جداول مستأجر/شركة جديدة — كلها بـ `tenant_id` + `@@unique([tenantId, id])` + مفاتيح مركبة:
  - `units`, `tax_categories` (مع `rate Decimal(9,4)` + `einvoice_code`), `payment_methods` — `@@unique([tenantId, code])`.
  - `accounts` — `@@unique([tenantId, companyId, code])`، شجرة ذاتية `parent_id` بمفتاح مركب `(tenant_id, company_id, parent_id)`، حقول `level`, `account_type`, `normal_balance`, `is_postable`, `is_control`, `control_type`.
  - `account_mappings` — `@@unique([tenantId, companyId, mappingKey])`.
  - `fiscal_years` (`@@unique([tenantId, companyId, code])`) + `fiscal_periods` (`@@unique([tenantId, fiscalYearId, periodNo])`, `status`, `closed_at/by`).
  - `document_sequences` — `@@unique([tenantId, companyId, documentType, fiscalYearId])`، `prefix`, `next_number`, `padding`.
- Migration: `20261107194849_phase2_financial_setup` — مطبّقة على `erp_dev` و`erp_test`.
- كل النماذج الجديدة أُضيفت إلى `TENANT_MODELS` في `tenant-prisma.ts` → عزل تلقائي.

### الشجرة الجاهزة (`src/platform/accounting/`)
- `chart-template.ts`: قالب §8.7 كاملاً (35 حساباً: 5 جذور + 6 مجموعات + 24 حساباً ترحلياً) + `ACCOUNT_MAPPING_KEYS` الـ13 + بادئات المستندات الافتراضية + الوحدات/الضرائب/طرق الدفع الافتراضية.
- `chart-provisioning.service.ts`: إنشاء idempotent داخل معاملة — يتخطى الحسابات/المفاتيح الموجودة (upsert)، يحسب `level` من الشجرة، يزرع الوحدات (7) والفئات الضريبية (2) وطرق الدفع (4).
- يُستدعى داخل معاملة `POST /auth/register` (معاملة واحدة) وعبر `POST /accounting/setup/provision` للمستأجرين الحاليين — تحقّق e2e: إعادة التشغيل لا تكرر شيئاً.

### الحسابات (`accounts.service.ts` / `accounting.controller.ts`)
- `GET /accounts` قائمة مسطّحة (الشجرة تُبنى في الواجهة)، `POST /accounts`، `PATCH /accounts/:id`.
- كود الحساب فريد ضمن الشركة → `409 CONFLICT`.
- إنشاء ابن تحت أب يحوّل الأب تلقائياً إلى `is_postable=false` داخل نفس المعاملة.
- محاولة جعل أب له أبناء `is_postable=true` → `409`؛ إلغاء تفعيل حساب مستخدم في mapping أو له أبناء → `409` (فحص الرصيد عبر قيود اليومية Phase 3).
- `GET/POST /account-mappings` + `POST /account-mappings/bulk` — التحقق من أن الحساب الهدف نشط وقابل للترحيل وضمن نفس الشركة.

### السنوات والفترات (`fiscal.service.ts` / `fiscal.controller.ts`)
- `POST /fiscal-years`: تحقق من الترتيب الزمني + رفض التداخل (`409`)، ثم معاملة واحدة تنشئ السنة + الفترات الشهرية (مقتطعة على حدود السنة) + `document_sequences` لكل أنواع المستندات بالبادئة `{PREFIX}-{YEAR}`.
- `GET /fiscal-years`, `GET /fiscal-years/:id` (مع الفترات)، `GET /document-sequences?fiscalYearId=`.
- `POST /fiscal-periods/:id/close|open` — مقيّدان بـ `fiscal.close` ومدقّقان في `audit_logs` (`fiscal_period.close/open`).

### الإعدادات (`settings.service.ts` / `settings.controller.ts`)
- CRUD للوحدات والفئات الضريبية وطرق الدفع: `GET/POST /units|tax-categories|payment-methods` + `PATCH /:id` — كلها خلف `settings.manage` + كود فريد لكل مستأجر.

### الواجهة (`apps/web`)
- `AccountsPage`: شجرة حسابات (AntD Table مع توسيع هرمي، بناء العميل من القائمة المسطحة) + إضافة/تعديل/إلغاء تفعيل.
- `FiscalPage`: قائمة السنوات مع صفوف موسّعة → تبويبتا الفترات (12 شهراً، أزرار إغلاق/فتح) وتسلسلات المستندات + نافذة إنشاء سنة (RangePicker).
- `SettingsPage`: تبويبات Units / Tax categories / Payment methods مع CRUD موحّد.
- مفاتيح i18n كاملة عربي/إنجليزي + عناصر قائمة جديدة في `App.tsx`.
- `packages/api-client` أُعيد توليده (35 مساراً → ~22 دالة جديدة).

## التحقق
- `prisma migrate deploy` على `erp_dev` + `erp_test` ✅
- `pnpm -r typecheck` ✅ — `pnpm -r lint` ✅ — `pnpm -r test` ✅
  - API: **26 اختباراً** (5 suites) = 9 وحدات + 9 e2e Phase 1 + **8 e2e Phase 2** جديدة على MariaDB حقيقية:
    - التهيئة عند التسجيل (35 حساباً، 13/13 mapping، وحدات/ضرائب/دفع)
    - idempotency لـ `/accounting/setup/provision`
    - رفض كود حساب مكرر (409)
    - الأب غير القابل للترحيل + منع `isPostable=true` لأب له أبناء (409)
    - منع إلغاء تفعيل حساب مستخدم في mapping (409)
    - سنة مالية → 12 فترة + sequences + رفض التداخل (409)
    - إغلاق فترة: VIEWER ممنوع (403) + OWNER ينجح + سطر تدقيق + إعادة فتح
    - عزل المستأجرين (حسابات/سنوات)
  - Web: Vitest ✅ + `vite build` ✅
- فحص حي على `erp_dev`: تسجيل مستأجر جديد → 35 حساباً، 13 mappings مربوطة، 7 وحدات، سنة 2025 → 12 فترة، إغلاق فترة 201.

## ملاحظات / متعمد تأجيله
- ترقيم المستندات الفعلي (`next_number` → `{PREFIX}-{YYYY}-{NNNNNN}` تحت قفل صف) Phase 3 مع محرك القيود.
- فحص رصيد الحساب قبل إلغاء التفعيل يتطلب `journal_lines` — Phase 3.
- `document_sequences` تُنشأ لكل سنة مالية؛ إعادة ترقيم عبر السنوات يُعالج عند الترحيل.
