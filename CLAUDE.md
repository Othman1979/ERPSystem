# CLAUDE.md — ERP Cloud

نظام محاسبة ومستودعات SaaS متعدد المستأجرين للشركات الصغيرة والمتوسطة في الأردن.
المطور: شخص واحد. أنت تعمل كمساعده في التنفيذ.

**المرجع الكامل:** `docs/BUILD_PLAN.md`. اقرأ الأقسام المتعلقة بالمرحلة الحالية قبل أي عمل.
**المرحلة الحالية:** 10  ← حدّث هذا السطر عند الانتقال إلى مرحلة جديدة.

---

## طريقة العمل

1. **خطة قبل الكود.** لأي مهمة غير بسيطة: اعرض قائمة الملفات التي ستنشئها أو تعدلها، والجداول المتأثرة، والاختبارات التي ستكتبها، وانتظر الموافقة.
2. **مرحلة واحدة فقط.** لا تنفذ شيئاً من مرحلة لاحقة. إذا احتجت شيئاً منها، اذكره ولا تبنه.
3. **الاختبار مع الكود.** كل وحدة تأتي مع اختباراتها. لا تعتبر المهمة منتهية قبل أن تنجح `pnpm test` و`pnpm typecheck` و`pnpm lint`.
4. **اختبارات المحاسبة والمخزون:** السيناريوهات الذهبية في القسم 18 من الخطة هي المرجع. **لا تعدّل الأرقام المتوقعة في هذه الاختبارات لتنجح.** إذا فشل اختبار ذهبي، أصلح الكود أو اعرض المشكلة على المالك.
5. **migrations:** أنشئها بـ `prisma migrate dev --name <وصف>`. لا تعدّل migration طُبقت سابقاً. اعرض SQL الناتج للمراجعة عند تغيير جداول مالية.
6. **قرار غير محسوم؟** لا تخمّن. اذكره صراحة، واقترح خيارين أو ثلاثة، واكتب ADR في `docs/decisions/NNNN-title.md` بعد الموافقة.
7. **نهاية المرحلة:** اكتب `docs/phase-reports/phase-N.md` وفق القسم 22 من الخطة.

## الأوامر

```bash
pnpm install
pnpm dev                 # api + web
pnpm --filter api dev
pnpm --filter web dev
pnpm test
pnpm typecheck
pnpm lint
pnpm --filter api prisma migrate dev --name <name>
pnpm --filter api prisma db seed
pnpm api-client:generate # يولد packages/api-client من OpenAPI
pnpm --filter api job:tenant-status # Cron يومي: دورة حالات الاشتراك (ADR-009)، بعد pnpm build
pnpm --filter api job:einvoice-send # Cron كل دقيقة: إرسال الفوترة الإلكترونية (ADR-009 §15)
pnpm --filter api job:purge-tenant <id> [--confirm "<name>"] # يدوي: حذف مستأجر ملغى بعد الاحتفاظ (§14)
pnpm --filter api job:preflight          # قبل النشر وبعده: جاهزية الخادم (ADR-010 §10.1)
pnpm --filter api job:backup             # Cron يومي: نسخة القاعدة والمرفقات مع تدوير (ADR-010 §10.2)
pnpm --filter api job:backup-verify <folder|latest> [--keep] # شهري: استعادة في قاعدة مؤقتة وفحصها
pnpm --filter api job:error-digest       # Cron كل ساعة: تنبيه بالأخطاء الجديدة إلى ALERT_WEBHOOK_URL (ADR-010 §10.3)
pnpm --filter api start:web              # تجربة محلية بشكل الإنتاج: الـ API المبني يقدّم الواجهة المبنية على 3002
pnpm --filter api job:grant-platform-admin <email> [--revoke] # يدوي: مدير المنصة
```

> حدّث هذا القسم عند إضافة أوامر جديدة.

## البنية

```text
apps/api      NestJS + Prisma + MariaDB
apps/web      React + Vite + Ant Design + TanStack Query + react-i18next
packages/api-client   مولد من OpenAPI — لا تعدّله يدوياً
docs/         الخطة، القرارات، تقارير المراحل
```

وحدات الـ API: `common`, `platform`, `settings`, `accounting`, `inventory`, `parties`, `sales`, `purchasing`, `treasury`, `einvoice`, `reports`, `onboarding`, `jobs`.
وحدة لا تستعلم جداول وحدة أخرى مباشرة؛ تستخدم الخدمة المصدّرة منها.

---

## قواعد إلزامية — لا استثناءات

### المال والأرقام
- **ممنوع `number` لأي مبلغ أو كمية أو تكلفة أو نسبة.** استخدم `Prisma.Decimal` (decimal.js).
- ممنوع `parseFloat` و`Number()` و`toFixed()` على المبالغ.
- المبالغ المحفوظة: 3 خانات (`ROUND_HALF_UP`). الكميات وتكلفة الوحدة: 6 خانات.
- في API: المعرفات والمبالغ والكميات **نصوص** في الطلب والاستجابة.
- الأدوات المشتركة في `apps/api/src/common/decimal/` (`round3`, `round6`, `sum`, …). استخدمها ولا تكرر المنطق.

### تعدد المستأجرين
- `tenantId` يأتي من CLS فقط. **ممنوع قراءته من body أو query أو params.**
- استخدم `tenantScopedPrisma` في كل وحدات الأعمال. `systemPrisma` مسموح فقط في `platform` و`jobs`، مع تعليق يشرح السبب.
- كل `$queryRaw` على جدول متعدد المستأجرين **يجب** أن يتضمن `tenant_id = ${tenantId}`.
- كل جدول متعدد المستأجرين: `@@unique([tenantId, id])`، والعلاقات بمفاتيح مركبة `[tenantId, xxxId]`.
- كل endpoint جديد يحتاج اختبار عزل: مستخدم من مستأجر B لا يصل إلى بيانات A.

### الترحيل
- القيود المرحّلة تُنشأ **فقط** عبر `PostingService`. الحركات المخزنية **فقط** عبر `StockLedgerService`.
- الترحيل في معاملة Prisma تفاعلية واحدة (`timeout: 30000`) وفق الخطوات في القسم 10.1 من الخطة.
- القفل بـ `SELECT ... FOR UPDATE` عبر `tx.$queryRaw`، وبترتيب ثابت: `item_id` ثم `warehouse_id` تصاعدياً.
- **لا استدعاء لخدمة خارجية داخل المعاملة** (JoFotara، بريد، HTTP). اكتب صف outbox فقط.
- `Idempotency-Key` إلزامي على كل `/post` و`/reverse`.
- رقم المستند يُمنح عند الترحيل داخل المعاملة، وليس عند إنشاء المسودة.
- أعد حساب كل المجاميع والضرائب والتكاليف في الخادم، وتجاهل أي قيمة محسوبة قادمة من العميل.

### البيانات المرحّلة
- لا `update` ولا `delete` على مستند أو قيد أو حركة بحالة `POSTED`. التصحيح بالعكس فقط.
- لا أرقام حسابات ثابتة في الكود. استخدم `account_mappings` عبر `AccountMappingService`.
- `stock_balances` و`item_costs` إسقاطات؛ `stock_movements` هو مصدر الحقيقة.

### الأمان
- لا أسرار في الكود أو Git. أضف أي متغير جديد إلى `.env.example` وإلى schema التحقق من الإعدادات.
- لا تسجّل كلمات المرور أو tokens أو أسرار JoFotara.
- DTOs مع `class-validator`، و`ValidationPipe` بـ `whitelist` و`forbidNonWhitelisted`.

---

## أسلوب الكود

- TypeScript strict. لا `any` إلا مع تعليق مبرر.
- قاعدة البيانات `snake_case` عبر `@map` و`@@map`. الكود `camelCase` و`PascalCase`.
- الأسماء المترجمة: `nameAr` و`nameEn`.
- الأخطاء: ارمِ `DomainError` بكود من enum `ErrorCode` (مثل `STOCK_INSUFFICIENT`, `BACKDATED_STOCK_POSTING`, `PERIOD_CLOSED`, `UNBALANCED_ENTRY`). الفلتر العام يحولها إلى صيغة الخطأ الموحدة. أضف ترجمة كل كود جديد في الويب (`ar` و`en`).
- Controllers رفيعة؛ المنطق في Services.
- الواجهة: نصوص المستخدم كلها عبر i18n، لا نصوص عربية أو إنجليزية مكتوبة مباشرة في المكونات.
- الواجهة تستخدم `packages/api-client` فقط للاتصال بالـ API.
- التعليقات بالإنجليزية في الكود.

## الاختبارات

- اختبارات تكاملية على MariaDB حقيقية (قاعدة اختبار منفصلة)، لا mocks لقاعدة البيانات في منطق الترحيل والمخزون.
- بيانات الاختبار دائماً لمستأجرين على الأقل (A وB).
- اختبارات التزامن (القسم 10.4) تستخدم `Promise.all` على اتصالات منفصلة.
- بعد أي اختبار يرحّل مستندات مخزنية: تحقق أن `stock:verify` لا يجد فروقاً، وأن ميزان المراجعة متوازن.

## ما لا تفعله

- لا تضف مكتبات كبيرة أو تغيّر قراراً في القسم 3 من الخطة دون موافقة.
- لا تستخدم Puppeteer أو Chromium (الاستضافة لا تدعمه بشكل موثوق). PDF عبر pdfmake.
- لا تعتمد على Redis أو خدمات daemon. المهام المجدولة عبر أوامر يستدعيها Cron.
- لا تبنِ ميزات من القسم 2.2 أو 20 من الخطة (مؤجلة).
- لا تفترض تفاصيل مواصفة JoFotara من الذاكرة؛ اطلب الوثيقة الرسمية أو ارجع إلى `docs/decisions/0005-jofotara-fields.md`.
