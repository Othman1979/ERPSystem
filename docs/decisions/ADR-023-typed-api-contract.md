# ADR-023: عقد API مكتوب الأنواع (أنواع الاستجابة في OpenAPI)

**الحالة:** مقبول (`decisions.md`: إصلاح PLAT-15) — الموجة الثالثة، المرحلة 3
**التاريخ:** 2026-11-14
**المرجع:** PLAT-15 (`review-platform.md`)، WEB-12 (`review-web-eng.md`)، ADR-022 (عقد الترقيم).

## المشكلة
- كل العمليات الـ 192 في وثيقة OpenAPI بلا نوع استجابة، فالعميل المولَّد يعيد `data: void`، والواجهة تحوّل الأنواع يدوياً بـ `as unknown as` في 99 موضعاً، وبـ `as never` على أجسام الطلبات في 50 موضعاً.
- 55 DTO طلب كانت `{}` في الوثيقة (لا swagger plugin).
- أي تغيير في شكل استجابة لا يكسر الـ typecheck، ويصل الخطأ إلى المستخدم وقت التشغيل.

## القرار

### 1. توثيق فقط، لا تغيير في أي جسم استجابة
- لا `ClassSerializerInterceptor` ولا `class-transformer` على المخرجات، ولا إعادة تسمية أو تنسيق. DTO الاستجابة يصف ما يُرسل اليوم بالضبط، والإثبات في §5.

### 2. مصادر الأنواع
- **swagger CLI plugin** في `nest-cli.json` (`classValidatorShim`، `introspectComments`، `esmCompatible`): يوثّق DTOs الطلب من class-validator.
- **`common/openapi/prisma-models.ts` مولَّد** من `schema.prisma` (`pnpm --filter api openapi:models`): صنف `<Model>Row` لكل نموذج بأعمدته كما تصل JSON: BigInt وDecimal نصوص، DateTime نص `date-time`، Int `integer`، `Type?` قابل لـ null، والـ enums باسمها. فحص ثابت يفشل إن تأخر الملف عن الـ schema.
- **DTO استجابة لكل وحدة** في `dto/*-response.dto.ts`، يبني على الـ Row (`extends`، `PickType`، `OmitType`) ويضيف العلاقات المضمَّنة بأصناف مسمّاة. أسماء الأصناف فريدة في كل الـ API (فحص ثابت)، لأن OpenAPI يفهرس المخططات بالاسم.
- **مساعدات مشتركة** في `common/openapi/responses.ts`: `ApiPagedResponse` و`PageOf` (`{ items, page, pageSize, total }`)، و`ApiKeysetResponse` و`KeysetOf` (`{ items, nextCursor, summary? }` بثلاثة أوضاع للملخص)، و`ApiOneOfResponse`، و`ApiFileResponse` (ملف PDF/xlsx/zip، مع JSON المسار نفسه بلا `format`)، و`DeletedDto` و`DeactivatedDto`.

### 3. الأخطاء
- غلاف الخطأ الموحد (`ErrorResponseDto`) هو الاستجابة `default` لكل عملية، يضيفه `buildApiDocument` مركزياً.

### 4. العميل المولَّد (orval)
- `forceSuccessResponse`: `apiFetch` يرمي `ApiError` على أي رد غير 2xx، فالدالة المولَّدة تعيد نوع النجاح فقط.
- أنواع المحتوى `pdf` و`xlsx` و`zip` مستبعدة من أنواع العميل (الوثيقة ما زالت تذكرها)، لأن الملفات تُجلب بـ `apiFetchBlob`، فيبقى نوع JSON بلا اتحاد مع `Blob`.
- `OPENAPI_INPUT` يحدد مصدر الوثيقة (URL أو ملف) بدل الخادم المشترك على 3001.

### 5. الإثبات والحراسة
- `test/e2e/openapi-contract.e2e.spec.ts`: كل عملية لها استجابة نجاح بمخطط غير فارغ، إلا قائمة صريحة قصيرة من مسارات 204 الحقيقية (5). ثم عيّنة من كل وحدة (صفحات مرقمة، صفحات مؤشر بصفحتها الثانية، اتحاد، ملف، والمستأجر B) تُطابَق ردودها الحقيقية مع مخططها.
- `common/openapi/schema-check.ts`: مطابقة صارمة: المفتاح غير المعلن خطأ، كالمفقود، والرقم مكان النص، وnull حيث لا يُسمح.
- **تدقيق الاستجابات** (`OPENAPI_RESPONSE_AUDIT=<ملف>`، للاختبار فقط، يُتجاهل في الإنتاج): middleware يطابق كل رد 2xx مع مخططه ويكتب الفروق سطراً لكل فرق، ولا يغيّر الرد. CI يشغّل كل اختبارات e2e به ويفشل إن لم يكن الملف فارغاً، فكل مسار يستدعيه أي اختبار مفحوص.

## العواقب
- مسار جديد بلا `@Api…Response` أو بمخطط فارغ يُفشل اختبار التغطية. DTO لا يطابق الرد يُفشل التدقيق في CI.
- تغيير في `schema.prisma` يتطلب `openapi:models`.
- بعد تغيير شكل استجابة: `pnpm api-client:generate`، والـ typecheck في الويب يكشف كل قارئ متأثر.
