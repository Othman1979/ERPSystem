# Phase 1 — المنصة والعزل بين المستأجرين

**الحالة:** مكتملة ومُتحقق منها
**النطاق:** مخطط المنصة + المصادقة + الصلاحيات + حدود الباقات + واجهة أولية

## ما تم بناؤه

### قاعدة البيانات (`apps/api/prisma/schema.prisma`)
- جداول المنصة: `plans`, `currencies`, `roles`, `role_permissions`, `users` (+`is_platform_admin`), `refresh_tokens` (+`tenant_id`, `family_id`, `replaced_by_id` للتدوير وكشف إعادة الاستخدام).
- جداول المستأجر: `tenants`, `subscriptions`, `companies`, `branches`, `tenant_memberships`, `membership_branches`, `audit_logs`, `attachments`, `idempotency_keys` — كلها بـ `tenant_id` و`@@unique([tenantId, id])` ومفاتيح مركبة للعلاقات داخل المستأجر.
- Migrations: `phase1_platform`, `refresh_token_tenant` — مطبّقة على `erp_dev` و`erp_test`.

### البنية التحتية المشتركة (`src/common/`)
- `guards/`: `AuthGuard` (JWT + تحميل المستخدم إلى CLS)، `TenantGuard` (التحقق من عضوية ACTIVE + تحميل الصلاحيات + وضع القراءة فقط للمستأجرين SUSPENDED/CANCELLED)، `PermissionsGuard`، `PlatformAdminGuard`.
- `decorators/`: `@Public`, `@TenantOptional`, `@RequirePermission`, `@PlatformAdmin`, `@CurrentUser`, `@CurrentTenant`, `@CurrentMembership`.
- `prisma/tenant-prisma.ts`: امتداد `$extends` يحقن `tenant_id` تلقائياً في كل عمليات القراءة/الكتابة على جداول المستأجر (يعمل من وسيط CLS أو وسيط صريح).
- `idempotency/`: `IdempotencyInterceptor` عام — يفرض `Idempotency-Key` على مسارات `*/post|*/reverse`، يخزن الطلب/الاستجابة في `idempotency_keys`، ويعيد التشغيل عند تكرار نفس المفتاح، ويرفض `IDEMPOTENCY_KEY_REUSED` عند اختلاف الحمولة.
- `audit/`: `AuditService` للكتابة في `audit_logs` (يستخدم عميل النظام عمداً — تدقيق يشمل أحداث المنصة).
- `plan-limits/`: `PlanLimitsService` — `assertUserSlotAvailable` / `assertBranchSlotAvailable` → `402 PLAN_LIMIT_EXCEEDED`.
- `permissions/`: كتالوج ثابت للأذونات + `ROLE_PERMISSIONS` للأدوار الخمسة (OWNER, ACCOUNTANT, STOREKEEPER, CASHIER, VIEWER).

### المصادقة (`src/platform/auth/`)
- Argon2id لتجزئة كلمات المرور.
- Access JWT (15 دقيقة افتراضياً) + Refresh token دوّار (30 يوماً): تخزين `sha256` للهاش، عائلة `family_id`، `replaced_by_id`؛ إعادة استخدام توكن ملغى تُلغي العائلة كاملة.
- `POST /auth/register`: معاملة واحدة تنشئ المستأجر (TRIAL، 14 يوماً) + الشركة + الفرع الرئيسي + المالك + الاشتراك التجريبي.
- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me`, `GET /me/tenants`, `POST /me/switch-tenant`.
- Refresh token في cookie من نوع `httpOnly`, `sameSite=strict`, `path=/api/v1/auth`.

### الوحدات
- `platform/users`: قائمة الأعضاء، دعوة (دور + فروع + كلمة مرور اختيارية/مؤقتة)، تحديث الدور/الحالة/الفرع الافتراضي، إيقاف (يلغي refresh tokens لذلك المستأجر) — مع حماية آخر OWNER نشط.
- `platform/branches`: CRUD + حذف ناعم (`is_active=false`) + حد الباقة.
- `platform/admin`: قائمة/تفاصيل المستأجرين، تغيير الحالة، تمديد التجربة، إنشاء اشتراك — محمية بـ `@PlatformAdmin` + تدقيق لكل عملية.

### الواجهة (`apps/web`)
- `AuthContext` + `setAccessToken`/تحديث تلقائي عبر refresh cookie عند 401 (deduped).
- صفحات: دخول، تسجيل، لوحة تحكم، مستخدمون (دعوة/أدوار/إيقاف)، فروع (CRUD)، مبدّل مستأجر في الترويسة — كلها ثنائية اللغة (ar RTL / en LTR).
- `packages/api-client`: أُعيد توليده من Swagger الحي؛ `runtime.ts` صار يطبّق عقد orval (`{data,status,headers}`) + حقن Bearer + `credentials:'include'` + إعادة محاولة واحدة بعد التحديث.

## التحقق
- `pnpm -r typecheck` ✅ — `pnpm -r lint` ✅ — `pnpm -r test` ✅ (API: 18 اختباراً = 9 وحدات + 9 تكاملية؛ Web: 1)
- تكاملية على MariaDB حقيقية (`erp_test`) بمستأجرين A وB: عزل `/users` و`/branches`، رفض `switch-tenant` غير المشروع، حد الباقة 402، صلاحيات الأدوار 403، تدوير/إلغاء عائلة التوكن، قراءة-فقط عند الإيقاف، 401 بدون مصادقة.
- فحص يدوي حي: register → login → me → users → branches → admin 403 → suspend → read-only → reactivate.

## قرارات موثقة
- `PrismaService` بالتركيب لا الوراثة (توليد Prisma 7 + NodeNext) — التفاصيل في `docs/decisions/`.
- `refresh_tokens.tenant_id` أُضيف في migration ثانية لأن الـ access token يحتاج `tid` بعد التحديث.
- الدعوة بدون بريد إلكتروني في MVP: تُنشأ كلمة مرور مؤقتة تُعرض مرة واحدة للمدير.
- اختبار التكامل يشغّل `node dist/main.js` كعملية فرعية (يتطلب `pnpm build` قبل `pnpm test`).

## ملاحظات / متبقٍ
- `IdempotencyInterceptor` مفعّل لكن لا توجد مسارات `*/post` بعد (تصل مع مستندات المخزون/المحاسبة في مراحل لاحقة) — منطقه رُوجع يدوياً وسيُغطى باختبار تكاملي عند أول مستند.
- لا استدعاءات JoFotara أوWorker بعد — خارج النطاق.
- `currencies` و`plans` و`roles` جداول منصة (ليست tenant-scoped) — الاستعلامات عليها عبر `prisma.client` مع تعليقات تبرير.
