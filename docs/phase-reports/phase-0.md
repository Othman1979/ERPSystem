# تقرير المرحلة 0 — البيئة والأساس

**التاريخ:** 7 نوفمبر 2026

## 1. ما تم إنجازه مقابل المخرجات

| المخرج المطلوب | الحالة |
|---|---|
| Monorepo بـ pnpm workspaces (`apps/api`, `apps/web`, `packages/api-client`) | تم |
| NestJS: config بتحقق schema، nestjs-cls، helmet، throttler، swagger، فلتر أخطاء موحد، Interceptor تحويل BigInt/Decimal، requestId | تم |
| Prisma متصل بـ MariaDB، مع migration تجريبية | جزئي — الاتصال والـ client يعملان؛ لا جداول بعد (تُضاف في المرحلتين 1–2)، ولا يوجد ما يُرحّل |
| React + Vite + Ant Design + i18n + RTL + TanStack Query | تم |
| توليد `api-client` من OpenAPI بأمر واحد | تم — `pnpm api-client:generate` يولّد `src/generated/api.ts` عبر orval (fetch client + mutator `apiFetch`) |
| ESLint + Prettier + TypeScript strict | تم (prettier config فقط؛ لا scripts تنسيق بعد) |
| Jest مع قاعدة بيانات اختبار، وVitest للويب | جزئي — Jest (ESM) وVitest يعملان باختبارات unit؛ اختبارات التكامل على MariaDB تبدأ مع المرحلة 1 |
| GitHub Actions: lint، typecheck، test | تم — `.github/workflows/ci.yml` مع خدمة MariaDB 11 |
| `.env.example`، `README.md`، `CLAUDE.md` | تم |
| `GET /api/v1/health` يتحقق من اتصال قاعدة البيانات | تم — متحقق محلياً: `{"status":"ok","db":"up"}` |
| نشر تجريبي على Hostinger | مؤجل — يتطلب بيانات الاستضافة |

## 2. الجداول والـ migrations

لا جداول في المرحلة 0. `prisma/schema.prisma` يحتوي datasource/generator فقط.
`prisma migrate dev --name init` أبلغ "Already in sync" لعدم وجود نماذج — متوقع.

## 3. الـ endpoints والشاشات

- `GET /api/v1/health` — يفحص `SELECT 1` على القاعدة، يعيد 503 `DB_UNAVAILABLE` عند الفشل.
- Swagger على `/api/docs`.
- شاشة الويب الوحيدة: فحص صحة النظام (يستدعي `/api/v1/health` عبر vite proxy).

## 4. نتائج اختبارات القبول

- [x] `pnpm install && pnpm dev` يشغّل الـ API (:3001) والويب (:5173) — متحقق.
- [x] `/api/v1/health` يعمل محلياً (200 مع قاعدة تعمل، 503 بدونها) — متحقق.
- [x] الويب يعرض نتيجة health من الـ API — الصفحة مبنية؛ العرض المرئي للواجهة يحتاج تحققاً بصرياً من المالك.
- [ ] migration تُطبق على قاعدة اختبار وقاعدة Hostinger — لا migrations بعد؛ Hostinger مؤجل.
- [x] استجابة فيها BigInt وDecimal تُحوّل إلى strings — `SerializeInterceptor` + اختبار وحدة.
- [ ] CI أخضر — الـ workflow جاهز، لم يُدفع إلى GitHub بعد.
- [x] لا أسرار في Git — `.env` في `.gitignore`، القيم في `.env` تجريبية فقط.

## 5. أوامر التشغيل

```bash
pnpm install
pnpm dev              # api :3001 + web :5173
pnpm --filter api dev
pnpm --filter web dev
pnpm test && pnpm typecheck && pnpm lint
pnpm --filter api prisma migrate dev --name <name>
pnpm api-client:generate   # يتطلب تشغيل الـ API
```

قاعدة البيانات المحلية: XAMPP MariaDB 10.4 على `localhost:3306`، قاعدة `erp_dev` أُنشئت، `apps/api/.env` يحتوي `DATABASE_URL` الافتراضي `mysql://root:@localhost:3306/erp_dev`.

## 6. المشاكل المعروفة والديون التقنية

1. **Prisma 7 + NestJS 12 ESM:**
   - `@nestjs/* v12` became ESM-only → `apps/api` is `"type": "module"`, `module: NodeNext`, وكل الـ imports النسبية بصيغة `.js`.
   - Prisma 7 يتطلب `prisma-client` generator + driver adapter (`@prisma/adapter-mariadb`) و`prisma.config.ts` بدل `url` في الـ schema.
   - `importFileExtension = "js"` في الـ generator ضروري وإلا يفشل runtime بـ `ERR_MODULE_NOT_FOUND`.
   - `class X extends PrismaClient` يفقد الأنواع تحت NodeNext → `PrismaService` يستخدم composition (`prisma.client`)؛ سيُعاد النظر عند بناء `tenantScopedPrisma` في المرحلة 1.
   - Jest يعمل بوضع ESM (`node --experimental-vm-modules`).
2. **`packages/api-client`:** `src/index.ts` يحتوي `getHealth` مكتوباً يدوياً مؤقتاً لأن نوع استجابة health في OpenAPI غير دقيق (200 بدون schema). سيُستبدل تدريجياً بالمولّد.
3. **C: ممتلئة 100%** على جهاز التطوير تسببت بانهيار Vite/npm — نُظفت caches (~2GB)؛ يوصى بتحرير مساحة إضافية.
4. **`mariadb` مثبّت بنسخةexact `3.5.4`** لمطابقة types الخاصة بـ `@prisma/adapter-mariadb`.
5. helmet v8 / throttler v6 / config v12 / swagger v12 / nestjs-cls v7 — أحدث الإصدارات major؛ راقب أي كسور توافق في المراحل القادمة.

## 7. القرارات المتخذة

- NestJS 12 + Prisma 7 (أحدث الإصدارات المستقرة) بدل إصدارات أقدم — موثق أعلاه وفي الكود.
- Ant Design v5 (وليس v6) لتقليل مخاطر التوافق مع React 19 — يمكن الترقية لاحقاً.
- أوامرDescriptions في health مؤقتة — المرحلة 8 تعيد بناء التقارير.

## 8. ما يلزم قبل المرحلة 1

- موافقة المالك على هذا التقرير والبدء بمرحلة المنصة والعزل.
- التأكد من بقاء MariaDB يعمل (حالياً أُقلع يدوياً من `C:\xampp\mysql\bin\mysqld.exe`).
- قرار: هوية git (user.name/email) قبل أول commit إن رغب المالك بإدارة git.
