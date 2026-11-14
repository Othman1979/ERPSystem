# مراجعة هندسة الواجهة والأداء — review-web-eng

التاريخ: 2026-11-13 · الفرع: `main` @ b987e0d · الجلسة: `review-web-eng`

**الطريقة:**
- بنيتُ الواجهة بـ `vite build` في مجلد مؤقت خارج المستودع، مرة بلا sourcemap ومرة معها لتحليل التركيب.
- شغّلت `vite preview` بإعداد مؤقت خارج المستودع على المنفذ 5416، يمرّر `/api` إلى نسخة API خاصة بي على 3416.
- أنشأت مستأجرين تجريبيين، `Review review-web-eng A` و`Review review-web-eng B`.
- استخدمت المتصفح المدمج تحت الاسم `webeng.localhost`. السبب: كوكي التحديث في ملف المتصفح المشترك تابع للمضيف `localhost` لا للمنفذ، فكان سيتداخل مع جلسات المراجعة الأخرى.
- حاكيت انقطاع الشبكة واستجابة 502 بصيغة HTML والطلبات المعلّقة باستبدال `window.fetch` داخل الصفحة. أما توقف الـ API فحاكيته بإيقاف نسخة 3416 وإعادة تشغيلها فعلاً.
- قرأ وكيلا Sonnet الكود. **تحققتُ بنفسي من كل بند في جدول النتائج** بقراءة السطر أو بإعادة الإنتاج.

> **ملاحظة بيئة:** امتلأ القرص `C:` تماماً (0 بايت) أثناء المراجعة، ولم يكن السبب ملفاتي. لذلك توقف توليد بيانات الحجم عند نحو 100 صنف و100 طرف و100 فاتورة مسودة. أرقام الحجم الكبير أدناه مستنتجة من الكود ومن أحجام الاستجابات المقاسة، وموسومة بذلك.

---

## 1. النطاق المغطى

| # | البند | النتيجة |
|---|---|---|
| 1 | بناء الإنتاج وتحليل التركيب (sourcemap) | ✅ حزمة JS واحدة 2,061.6 KB (gzip 607 KB)، بلا تقسيم |
| 2 | التحميل الأول (preview محلي) | ✅ DCL ≈ 200ms محلياً؛ 3 ملفات خط فقط تُحمَّل فعلاً (unicode-range يعمل) |
| 3 | الخطوط | ✅ IBM Plex Sans Arabic، 4 أوزان. يُنزَّل woff2 فقط، وملفات woff مولّدة احتياطاً ولا تُطلب |
| 4 | pdfmake | ✅ غير موجود في الويب، فالـ PDF يُولَّد في الخادم. لا مشكلة |
| 5 | Cache-Control للأصول في الإنتاج (`serve-web-app.ts`) | ✅ `immutable` للأصول و`no-cache` لـ index.html |
| 6 | ضغط الاستجابات (gzip/br) من خادم Node | ❌ غير موجود (WEB-11) |
| 7 | عدد طلبات API لكل شاشة (19 مساراً) | ✅ مقيس. الجدول في §1.1 |
| 8 | مفاتيح الاستعلام وstaleTime والإبطال | ❌ عدة مشاكل (WEB-08، 09، 13) |
| 9 | `runtime.ts`: التحديث وsingle-flight وإعادة المحاولة والمهلة وتحويل الأخطاء | ⚠️ single-flight موجود داخل التبويب، ولا مهلة (WEB-05، 06، 14) |
| 10 | انقطاع الشبكة أثناء الحفظ (نموذج طرف) | ⚠️ تظهر رسالة «خطأ داخلي في الخادم» ويبقى النموذج (WEB-06) |
| 11 | استجابة 502 بصيغة HTML | ⚠️ نفس الرسالة المضللة (WEB-06) |
| 12 | طلب معلّق بلا نهاية | ❌ زر التحميل يدور بلا حد ولا مهلة (WEB-05) |
| 13 | النقر المزدوج على «حفظ» في نموذج الطرف | ✅ محمي، فزر antd في حالة loading لا يرسل طلباً ثانياً |
| 14 | النقر المزدوج على «ترحيل» | ⚠️ الفواتير محمية. في تسويات وتحويلات المخزون لا يتعطل الرابط بعد Popconfirm (WEB-16). الخادم يمنع الترحيل المزدوج |
| 15 | إنشاء ثم ترحيل (المرتجعات وإشعارات البضاعة) ثم إعادة المحاولة | ❌ بالقراءة: كل نقرة تنشئ مستنداً جديداً بمفتاح جديد (WEB-07) |
| 16 | الـ API متوقف عند فتح الصفحة | ❌ تظهر شاشة الدخول كأن المستخدم خرج (WEB-04)، لقطة `01` |
| 17 | الـ API متوقف أثناء التنقل | ❌ القوائم تعرض «لا توجد بيانات / عدد النتائج: 0» (WEB-03)، لقطة `02` |
| 18 | عودة الـ API بعد التوقف | ❌ لا تعافٍ تلقائي ولا زر إعادة محاولة، و0 طلبات خلال 20 ثانية (WEB-03) |
| 19 | خروج المستأجر A ثم دخول B في نفس التبويب | ❌ ظهرت أصناف A تحت ترويسة B (WEB-01) |
| 20 | تحديث الرمز من عدة تبويبات (4 iframes) | ✅ نجحت كلها في المتصفح. ❌ إعادة استخدام الكوكي بعد 50ms عبر curl تُبطل العائلة كلها (WEB-14) |
| 21 | اختبارات الويب `pnpm --filter web test` | ✅ 12 ملفاً و52 اختباراً، كلها ناجحة |
| 22 | جودة الكود: الأحجام والتكرار والأنواع وi18n والتوجيه | ✅ مقروءة (WEB-12، 15، 17–20) |
| 23 | الرسم: الجداول الكبيرة والـ memo | ⚠️ ترقيم من جهة العميل بـ 20 صفاً فلا حاجة للـ virtualization الآن. المشكلة الحقيقية سقف الخادم (WEB-02) |

### 1.1 طلبات API لكل شاشة

القياس من سجل الموارد في المتصفح، بتنقل SPA بعد الدخول. كل الطلبات متوازية ولا يوجد شلال.

| الشاشة | عدد الطلبات | الطلبات |
|---|---|---|
| `/` | 2 | dashboard/summary, company |
| `/accounts` | 2 | accounts, reports/trial-balance |
| `/journal` | 3 | journal-entries, accounts, parties |
| `/opening-balances` | 5 | journal-entries(OPENING), accounts, account-mappings, fiscal-years, parties |
| `/treasury` | 3 | accounts, parties, cash-boxes |
| `/reports` | 3 | accounts, trial-balance, fiscal-years |
| `/sales` | **6** | parties(CUSTOMER), warehouses, **items (كل الأصناف)**, tax-categories, accounts, sales-invoices |
| `/purchases` | **6** | نفس نمط المبيعات |
| `/items` | **6** | items, units, item-groups, warehouses, tax-categories, **stock/balances (كل الأرصدة)** |
| `/stock` | 3 | warehouses, items(STOCK), stock/balances |
| `/warehouses` | 2 | warehouses, branches |
| `/users` | 2 | users, users/roles |
| باقي الشاشات | 1 لكل شاشة | `/fiscal`, `/einvoice`, `/goods-notes`, `/parties`, `/branches`, `/settings`, `/health` |

**الحكم:**
- عدد الطلبات معقول، ولا شاشة تُطلق عدداً مفرطاً.
- المشكلة في **الحجم والتكرار**:
  - شاشة قائمة المبيعات تجلب كل الأصناف وكل العملاء ودليل الحسابات قبل أن يفتح المستخدم أي نموذج.
  - مع `staleTime: 0` يتكرر ذلك عند كل زيارة.
- **الحجم المقاس:** نحو 71 KB لكل 100 صنف، و45 KB لكل 100 طرف، و75 KB لكل 100 فاتورة.
- **المستنتج عند السقف:** نحو 355 KB للأصناف (500) و225 KB للأطراف (500). لا ضغط في الخادم.

---

## 2. جدول النتائج

| id | الخطورة | العنوان | الدليل | الأثر | الإصلاح المقترح | الجهد | الملفات |
|---|---|---|---|---|---|---|---|
| WEB-01 | **critical** | ذاكرة TanStack Query لا تُفرَّغ عند الخروج أو الدخول أو تبديل المستأجر، فتظهر بيانات مستأجر لمستأجر آخر | `apps/web/src/auth/AuthContext.tsx:147-157` (logout) و`:127-139` (login/register) و`:173-178` (switchTenant): لا يوجد `queryClient.clear()`. `QueryClient` يُنشأ مرة واحدة في `main.tsx:29`. **مُعاد إنتاجه:** دخلت كـ A وفتحت `/items`، ثم خرجت ودخلت كـ B وفتحت `/items`. سجّل MutationObserver صف A `PIF01V-00000 خزانة موديل 0` تحت ترويسة `Review review-web-eng B`، وبقي نحو 80ms محلياً حتى وصلت استجابة B | يرى المستخدم التالي على نفس الجهاز (كاشير، محاسب مكتب خدمات، أو مدير منصة يبدّل المستأجرين) قوائم المستأجر السابق: أصنافه وأسعاره وعملاءه وفواتيره. مستنتج من سلوك TanStack ولم أُعِد إنتاجه: إذا فشل جلب B تبقى `data` القديمة معروضة بلا حد | استدعاء `queryClient.clear()` في `logout`، وقبل `setAccessToken` في `login` و`register` و`switchTenant`. الأمتن إضافةً لذلك: إعطاء `QueryClientProvider` أو شجرة التطبيق `key={userId:tenantId}` | S | `apps/web/src/auth/AuthContext.tsx` |
| WEB-02 | **high** | قوائم الخادم مقيّدة بسقف ثابت بلا ترقيم ولا `total`، والواجهة ترقّم وتبني المنتقيات من هذه القوائم المقطوعة | السقوف: `catalog.service.ts:126-127` (الأصناف 500، مرتبة بالرمز)، `parties.service.ts:26` (500)، `sales-invoices.service.ts:262-263` (300، الأحدث)، `purchase-invoices.service.ts:261`، `sales-returns.service.ts:147`، `vouchers.service.ts:79,234` (300)، `journal.service.ts:111` (200)، `adjustments/transfers/counts` (200)، `goods-notes.service.ts:44`، `einvoice-submissions.service.ts:45`. حركات الصنف `StockPage.tsx:1033-1035` بـ `pageSize:'100'` ثابت، و`total` لا يُستخدم. المنتقي `InvoiceLinesGrid.tsx:186` يبني الخيارات من `['items']` الكاملة دون بحث في الخادم | الصنف رقم 501 حسب الرمز **لا يظهر في قائمة الأصناف ولا يمكن اختياره في أي فاتورة أو إشعار أو تسوية**. العميل رقم 501 لا يمكن اختياره. الفواتير الأقدم من آخر 300 تختفي من القائمة، ومن نموذج المرتجع، ومن تخصيص سند القبض. كل ذلك يحدث بصمت ودون رسالة | ترقيم في الخادم (`page`, `pageSize`, `total`) للقوائم، ومنتقٍ يبحث في الخادم مع debounce للأصناف والأطراف. للتخصيص: endpoint بعنوان «الفواتير المفتوحة لطرف». للمرتجع: بحث برقم الفاتورة. ملاحظة: يتقاطع مع منطقة جلسات trade وledger في الـ API | L | services وcontrollers في `apps/api/src/platform/{inventory,parties,sales,purchases,treasury,journal,goods-notes,einvoice}`، و`apps/web/src/components/GridSelect.tsx`، والصفحات المعنية |
| WEB-03 | **high** | فشل الاستعلام يُعرض كقائمة فارغة، ولا رسالة ولا إعادة محاولة ولا تعافٍ بعد عودة الخادم | لقطة `shots/review-web-eng/02-api-down-list-shows-no-data.jpg`: 12 طلباً بحالة 502 (6 ومحاولة واحدة لكل منها)، والشاشة تقول «عدد النتائج: 0 / لا توجد بيانات». `isError` لا يُستخدم في أي صفحة أعمال (تظهر 11 إشارة فقط، في App وHealthPage وAccountsPage). `main.tsx:29-31` يضبط `refetchOnWindowFocus:false` ولا يعرّف `QueryCache.onError`. بعد إعادة تشغيل الـ API بقيت الشاشة فارغة، مع 0 طلبات خلال 20 ثانية | في نظام محاسبة، تُقرأ «لا توجد فواتير» حقيقةً. قد يعيد المستخدم إدخال مستندات يظنها ضاعت، أو يفترض فقدان البيانات | مكوّن مشترك `QueryState` أو `emptyText` للجداول يميّز الخطأ ويعرض زر «إعادة المحاولة». `QueryCache({ onError })` يعرض toast موحداً. `refetchOnReconnect` موجود افتراضياً، ويُضاف `refetchOnWindowFocus` للقوائم مع staleTime مناسب | M | `apps/web/src/main.tsx`، و`components/` (مكوّن جديد)، والصفحات التي تعرض جداول |
| WEB-04 | medium | تعذّر الوصول إلى الـ API عند فتح الصفحة يُظهر شاشة الدخول كأن الجلسة انتهت | `AuthContext.tsx:118-126`: أي خطأ غير 401 يضع `setStatus('guest')`. لقطة `01-api-down-at-boot-shows-login.jpg`: `/me` أعاد 502 فظهر نموذج الدخول بلا أي رسالة | بعد نشر أو إعادة تشغيل يظن المستخدمون أنهم خرجوا، فيعيدون إدخال كلمة المرور، ويصطدمون بحد الدخول 10/دقيقة، ويرون «خطأ داخلي». الكوكي ما زال صالحاً، وهذا ما ظهر بعد عودة الـ API | حالة ثالثة `unreachable`: شاشة «تعذّر الاتصال بالخادم» مع إعادة محاولة تلقائية (backoff) وزر | S | `apps/web/src/auth/AuthContext.tsx`، `apps/web/src/App.tsx`، `i18n/locales.ts` |
| WEB-05 | medium | لا مهلة للطلبات، و`signal` الخاص بـ TanStack لا يُمرَّر | `packages/api-client/src/runtime.ts:96-125`: `fetch` بلا `AbortSignal`. لا يوجد `AbortController` أو `signal` في `apps/web/src`. مُختبر: طلب معلّق أبقى زر الحفظ في حالة تحميل بلا نهاية | خادم بطيء أو اتصال جوال ضعيف يعني دوراناً لا ينتهي، ولا تُلغى الطلبات عند مغادرة الشاشة | `AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])` في `send()`، وتمرير `signal` من `queryFn: ({signal})`. تحويل `TimeoutError` إلى `ApiError(0,'NETWORK_TIMEOUT')` | S | `packages/api-client/src/runtime.ts` (يدوي وليس مولداً)، وصفحات الـ queryFn تدريجياً |
| WEB-06 | medium | أخطاء الشبكة واستجابات HTML تُعرض كـ «خطأ داخلي في الخادم» | `runtime.ts:150-151`: `JSON.parse` بلا try، فاستجابة 502 HTML من بروكسي ترمي `SyntaxError`. `fetch` المرفوض (offline) يرمي `TypeError`. كلاهما ليس `ApiError`، فالصفحات تعرض `errors.INTERNAL`. مُختبر في نموذج الطرف للحالتين | رسالة مضللة: المستخدم لا يعرف أن المشكلة في اتصاله، والدعم لا يميّز | تغليف `fetch` و`JSON.parse` لتحويلهما إلى `ApiError(0,'NETWORK_ERROR')` و`ApiError(status,'BAD_GATEWAY')`، مع ترجمات `ar` و`en`. يُدمج مع WEB-15 | S | `packages/api-client/src/runtime.ts`، `apps/web/src/i18n/locales.ts` |
| WEB-07 | medium | «حفظ وترحيل» في المرتجعات وإشعارات البضاعة ينشئ مستنداً جديداً عند كل إعادة محاولة، و`Idempotency-Key` جديد لكل نقرة | `SalesPage.tsx:1137-1143`، `PurchasesPage.tsx:1123+`، `GoodsNotesPage.tsx:228`: `create.mutateAsync()` ثم `post…(id, {headers: idemHeaders()})`. لا يُحفظ الـ id المُنشأ. `idempotency.ts` يقول «retries of the SAME action should reuse the key»، لكن كل مواضع الاستدعاء الـ 21 تولّد المفتاح داخل `mutationFn`. بالقراءة ولم أُعِد إنتاجه | إذا فشل الترحيل (فترة مغلقة، أو مخزون، أو انقطاع) يبقى النموذج مفتوحاً، وكل نقرة تنشئ مسودة مرتجع إضافية. وإذا ضاعت استجابة ترحيل ناجح تُنشأ وتُرحَّل **نسخة ثانية من المرتجع** (إشعار دائن مكرر) | حفظ الـ id المُنشأ في `useRef`، وفي إعادة المحاولة ترحيل نفس المسودة. توليد المفتاح مرة لكل «إجراء مستخدم» (`useRef` يُصفَّر عند النجاح أو الإلغاء) بدل كل `mutate` | M | `SalesPage.tsx`، `PurchasesPage.tsx`، `GoodsNotesPage.tsx`، `idempotency.ts` |
| WEB-08 | medium | إبطالات ميتة أو ناقصة: `['stock']` لا يطابق أي مفتاح، وأرصدة المخزون وميزان المراجعة ولوحة البداية لا تُحدَّث بعد الترحيل | `invalidateQueries({ queryKey: ['stock'] })` في `SalesPage.tsx:301,867`، `PurchasesPage.tsx:287,858`، `GoodsNotesPage.tsx:173`. المفاتيح الفعلية `stock-balances` و`stock-valuation` وغيرها، ولا يوجد مفتاح يبدأ بالعنصر `'stock'`. ترحيل قيد في `JournalPage.tsx:244` لا يُبطل `['trial-balance']` (`AccountsPage.tsx:124`) ولا `['dashboard-summary']`. حفظ حساب يُبطل `['accounts']` فقط، والنقطة نفسها مخزنة تحت 4 مفاتيح (WEB-13) | الشاشات المركّبة (المخزون، والأصناف مع الأرصدة، والتقارير) تعرض أرقاماً قديمة حتى إعادة التركيب. عملياً يخفف `staleTime:0` الأثر عند التنقل، لكنه لا يفيد مع شاشة مفتوحة | ملف `queryKeys.ts` بمفاتيح هرمية (`['stock','balances',…]`, `['accounting','trial-balance',…]`)، و`invalidate` حسب المجال بعد كل ترحيل أو عكس | M | `apps/web/src/queryKeys.ts` (جديد)، وكل الصفحات التي تستخدم `useQuery` |
| WEB-09 | medium | نفس مفتاح الاستعلام لبيانات مختلفة | `['sales-invoices','POSTED']`: في `SalesPage.tsx:1100` كل الفواتير المرحّلة (`paymentType:''`)، وفي `TreasuryPage.tsx:813` الآجلة فقط (`'CREDIT'`). مثله `['purchase-invoices','POSTED']` في `PurchasesPage.tsx:1086` و`TreasuryPage.tsx:818` | يعرض كل نموذج قائمة النموذج الآخر حتى ينتهي الجلب. إذا فشل الجلب تبقى القائمة الخاطئة: فواتير نقدية في تخصيص سند القبض، أو فواتير نقدية غائبة عن نموذج المرتجع | إضافة `paymentType` للمفتاح، أو استخدام مفاتيح WEB-08 | S | `SalesPage.tsx`، `PurchasesPage.tsx`، `TreasuryPage.tsx` |
| WEB-10 | medium | حزمة واحدة 2.06 MB (607 KB gzip) بلا تقسيم ولا تحميل كسول للمسارات | `routes.tsx:23-40` استيراد ثابت لـ 18 صفحة، ولا `React.lazy` ولا `import()` في `src`. التركيب من sourcemap: antd 603 KB + `rc-*` 442 KB (≈53%)، react-dom 203، صفحات التطبيق 213، i18n (اللغتان) 69، jsbarcode 63 (فقط لنافذة الباركود `ItemsPage.tsx:12,818`)، `@ant-design/icons-svg` 56 (الأيقونات مُشذّبة جيداً)، decimal.js 32 | تحميل أول أبطأ على شبكات الجوال الأردنية، فنحو 600 KB مضغوطة يجب تنزيلها وتحليلها قبل شاشة الدخول نفسها. كل إصدار يُبطل الحزمة كاملة من الكاش لعدم فصل vendor | `React.lazy` لكل صفحة مع `Suspense` في `App.tsx`. `import('jsbarcode')` داخل `BarcodeModal`. `build.rolldownOptions.output.codeSplitting` أو manualChunks لفصل react وantd لكاش طويل. لغة واحدة عند الطلب (اختياري) | M | `apps/web/src/routes.tsx`، `App.tsx`، `vite.config.ts`، `pages/ItemsPage.tsx` |
| WEB-11 | medium | خادم Node لا يضغط الأصول ولا JSON | تجربة `start:web` على 3416 مع `Accept-Encoding: gzip, br`: `Content-Length: 2061606` بلا `Content-Encoding`. لا `compression` في `apps/api/src` ولا `package.json`. `serve-web-app.ts:30` يستخدم `useStaticAssets` فقط. **غير مؤكد:** هل يضغط بروكسي Hostinger الأمامي (ADR-010)؟ | إن لم يضغط البروكسي: 2 MB للتحميل الأول بدل 607 KB، وقوائم JSON حتى ≈350 KB غير مضغوطة | التحقق من خادم Hostinger أولاً (`curl -H 'Accept-Encoding: br' -I`). إن لم يضغط: middleware `compression`، أو ملفات `.br`/`.gz` مسبقة البناء تُخدم بـ `Content-Encoding` | S | `apps/api/src/main.ts`، `apps/api/src/common/web/serve-web-app.ts` |
| WEB-12 | medium | العميل المولَّد بلا أنواع استجابة، و100 تحويل `as unknown as` وواجهات محلية مكررة | `packages/api-client/src/generated/api.ts`: 185 ظهوراً لـ `data: void`، لأن الـ controllers بلا `@ApiOkResponse`/DTO استجابة. يوجد 100 `as unknown as` في 25 ملفاً (SalesPage 11، PurchasesPage 11، ItemsPage 9، StockPage 9، TreasuryPage 8…). `Party` و`Item` و`Warehouse` و`TaxCategory` معرّفة مرتين في SalesPage وPurchasesPage، إضافة إلى `as never` على أجسام الطلبات (مثلاً `SalesPage.tsx:554`) | أي تغيير في شكل استجابة الـ API لا يكسر الـ typecheck، فيصل الخطأ للمستخدم وقت التشغيل. والقاعدة «الواجهة تستخدم api-client فقط» تُطبَّق شكلاً لا نوعاً | إضافة DTOs استجابة و`@ApiOkResponse({ type })` في الـ API تدريجياً (القوائم الأساسية أولاً)، وإعادة `pnpm api-client:generate`، وحذف الواجهات المحلية مع كل وحدة. يمكن البدء بقاعدة lint تمنع `as unknown as` الجديدة | L | controllers في `apps/api/src/platform/**`، `packages/api-client`، والصفحات |
| WEB-13 | medium | البيانات المرجعية تُجلب عند كل تركيب (`staleTime:0`) ونفس النقطة تحت مفاتيح متعددة | `accountingControllerListAccounts()` تحت 4 مفاتيح: `['accounts']` (`AccountsPage:119`)، `['accounts-postable']` (`JournalPage:151`…)، `['accounts-tree']` (`SalesPage:210`…)، `['accounts-all']` (`ReportsPage:103`). الأصناف تحت `['items']` و`['items',search,kind]` و`['items-stock']`. لا يوجد `staleTime` أو `gcTime` في أي موضع. القياس: كل دخول لـ `/sales` يعيد 6 طلبات تشمل كل الأصناف والعملاء والحسابات | تكرار جلب مئات الـ KB عند كل تنقل (بلا ضغط، WEB-11)، وعدم اتساق بعد التعديل لأن الإبطال يصيب مفتاحاً واحداً | hooks مشتركة (`useAccounts`, `useWarehouses`, `useTaxCategories`, `useUnits`) بمفتاح واحد و`staleTime` 5 دقائق، وإبطالها عند التعديل. القوائم الكبيرة (الأصناف والأطراف) تتحول إلى بحث في الخادم (WEB-02) | M | `apps/web/src/hooks/` (جديد) والصفحات |
| WEB-14 | low | تحديث الرمز: single-flight داخل التبويب فقط، وضياع استجابة `/auth/refresh` يُخرج المستخدم من كل الأجهزة | `runtime.ts:72-94` (`refreshPromise` لكل تبويب). في الخادم (`token.service.ts:86-91`) إعادة استخدام كوكي مُدوَّر تُبطل العائلة كلها بلا فترة سماح. **مُعاد إنتاجه بـ curl:** تحديثان بنفس الكوكي بفارق 50ms أعطيا `200` ثم `401`، ثم فشل حتى التبويب الناجح (`401`). في المتصفح نجحت 4 iframes متزامنة لأن وعاء الكوكي مشترك ولأن الفحص غير ذري، فيبقى رمزان صالحان في العائلة | إذا انقطع الاتصال بعد أن دوّر الخادم الرمز وقبل وصول `Set-Cookie`، يُبطل التحديث التالي العائلة كلها فيخرج المستخدم. الاحتمال منخفض لكن الأثر مزعج على الجوال | في الويب: `navigator.locks.request('erp-refresh', …)` حول `tryRefresh`. في الخادم (منطقة review-platform): فترة سماح قصيرة لإعادة الاستخدام، و`FOR UPDATE` على صف الرمز | S | `packages/api-client/src/runtime.ts`، `apps/api/src/platform/auth/token.service.ts` |
| WEB-15 | low | منطق تحويل الأخطاء مكرر نحو 42 مرة رغم وجود مساعد مشترك | تعبير ``err instanceof ApiError ? t(`errors.${err.code}`…) : t('errors.INTERNAL')`` في 25 ملفاً. `apiErrorText` موجود في `components/ExportButtons.tsx:24` ولا يستخدمه إلا 3 ملفات. توجد hooks محلية مكررة: `useApiError` (`ItemsPage:135`)، و`useApiMessage` (`StockPage:137`)، و`showError` (`SettingsPage:88`, `WarehousesPage:51`) | أي تحسين في الرسائل (WEB-06) يحتاج 42 تعديلاً | نقل `apiErrorText` إلى `src/errors.ts`، وإضافة `MutationCache({ onError })` افتراضي مع `meta` لتعطيله حيث تُعرض الرسالة محلياً | S | `apps/web/src/main.tsx` و`errors.ts` (جديد) والصفحات |
| WEB-16 | low | أزرار بلا حالة انتظار تسمح بالنقر المتكرر | `StockPage.tsx:462,706`: `Popconfirm onConfirm={() => post.mutate(row.id)}` بلا `okButtonProps.loading`، والرابط يبقى قابلاً للنقر. مثله deactivate وحذف المسودات في `AccountsPage:206`، `BranchesPage:83`، `ItemsPage:248`، `PartiesPage:144`، `WarehousesPage:87`، `JournalPage:267`، `UsersPage:111,118` | الخادم يمنع الترحيل المزدوج بقفل `FOR UPDATE`، لكن النقرة الثانية تعرض للمستخدم خطأ «المستند ليس مسودة» بعد نجاح الأولى | `okButtonProps={{ loading: post.isPending }}` أو تعطيل الصف أثناء الطلب | S | الملفات المذكورة |
| WEB-17 | low | ملفات صفحات ضخمة، والمبيعات والمشتريات متطابقتان بنحو 92% | `SalesPage.tsx` (1287 سطراً) و`PurchasesPage.tsx` (1273): نفس 7 مكونات. بعد توحيد الكلمات يبقى 192 سطراً مختلفاً فقط. ومعها `StockPage.tsx` (1184)، و`TreasuryPage.tsx` (1070)، و`ItemsTab` في `ItemsPage.tsx` (مكوّن واحد بنحو 460 سطراً) | كل إصلاح في الفواتير يُنفَّذ مرتين، وهذا ما حدث فعلاً في WEB-07 وWEB-08 وWEB-09 | استخراج «وحدة مستند تجاري» عامة (`TradeDocumentModule` بإعدادات sales/purchases)، وتقسيم الصفحات إلى `pages/sales/{InvoicesTab,InvoiceForm,…}.tsx` | L | `pages/SalesPage.tsx`، `pages/PurchasesPage.tsx` (يُفضَّل بعد WEB-07/08/09) |
| WEB-18 | low | قيمة `AuthContext` غير مُذكَّرة | `AuthContext.tsx:181-183`: `value={{…}}` كائن جديد في كل رسم، فيُعاد رسم كل مستهلك لـ `useAuth`، وهو موجود في كل صفحة تقريباً | إعادة رسم زائدة. الأثر محدود اليوم | `useMemo` للقيمة | S | `apps/web/src/auth/AuthContext.tsx` |
| WEB-19 | low | تغطية اختبارات الويب ضعيفة في المسارات الحرجة | 12 ملف spec: دوال مساعدة ومفاتيح i18n فقط. لا اختبار لـ `runtime.ts` (التحديث وتحويل الأخطاء)، ولا لـ `AuthContext`، ولا للشبكات `InvoiceLinesGrid`/`JournalLinesGrid`، ولا لأي تدفق «إنشاء ← ترحيل» | الأخطاء WEB-01 وWEB-04 وWEB-06 وWEB-07 كانت ستُكتشف باختبارات وحدة بسيطة | Vitest مع `fetch` وهمي لـ `runtime.ts`، وTesting Library لـ `AuthContext` (مسح الكاش وحالة unreachable) ونموذج المرتجع | M | `packages/api-client/src/runtime.spec.ts` و`apps/web/src/auth/AuthContext.spec.tsx` (جديدان) |
| WEB-20 | low | حالة الشاشة خارج الـ URL | التبويب والفلاتر والمستند المفتوح في `useState` (`SalesPage.tsx:168,263+`). `useSearchParams` يُقرأ مرة واحدة في `ReportsPage:83` و`StockPage:182` و`TreasuryPage:173` فقط | التحديث أو زر «رجوع» أو مشاركة رابط فاتورة يعيد المستخدم إلى القائمة | مسارات فرعية `/sales/invoices/:id` (المسارات مركّبة أصلاً بـ `/*`)، والفلاتر في `searchParams` | M | الصفحات و`App.tsx` |
| WEB-21 | low | فاصل عربي ثابت في واجهة الإنجليزية | `SetupWizardPage.tsx:187,244,246,258`: `.join('، ')` | الفاصلة العربية تظهر في الواجهة الإنجليزية | `t('common.listSeparator')` أو `Intl.ListFormat(i18n.language)` | S | `SetupWizardPage.tsx`، `locales.ts` |

**ما فحصته ووجدته سليماً** (لا يُعد نتيجة):
- المال: كل حقول المبالغ `InputNumber<string> stringMode`، ولا `parseFloat` ولا `Number()` على المبالغ.
- `amountsFor` تعيد حساب الـ Decimal لكل سطر عند كل ضغطة. الكلفة مهملة بأعداد الأسطر الواقعية.
- i18n: تماثل المفاتيح مضمون باختبارَي `locales.spec.ts` و`usedKeys.spec.ts`.
- الأيقونات مُشذّبة.
- لا N+1 في الاستعلامات.
- الاستطلاع (polling) محدود بحالات الفوترة الإلكترونية الجارية.

---

## 3. مكاسب سريعة (أقل من يوم لكل منها)

1. **WEB-01:** إضافة `queryClient.clear()` في `logout`/`login`/`register`/`switchTenant`. نحو أربعة أسطر، وتغلق تسرباً بين المستأجرين.
2. **WEB-09:** إضافة `paymentType` إلى مفتاحَي `['sales-invoices','POSTED']` و`['purchase-invoices','POSTED']`.
3. **WEB-08 (جزئي):** استبدال `['stock']` بالمفاتيح الفعلية، وإضافة `['trial-balance']` و`['dashboard-summary']` إلى إبطال الترحيل والعكس.
4. **WEB-05 + WEB-06:** مهلة 30 ثانية وتحويل أخطاء الشبكة وHTML في `runtime.ts`، وكودان جديدان مترجمان.
5. **WEB-04:** حالة «تعذّر الاتصال» بدل «ضيف» عند خطأ غير 401.
6. **WEB-10 (جزئي):** `import('jsbarcode')` الديناميكي (‑63 KB)، و`React.lazy` للمسارات (≈‑213 KB من صفحات التطبيق، إضافة إلى مكونات antd غير المشتركة).
7. **WEB-16:** `okButtonProps.loading` في Popconfirm الترحيل.
8. **WEB-18:** `useMemo` لقيمة السياق.

## 4. قرارات مطلوبة من المالك

1. **الترقيم في الخادم (WEB-02).** هل نعتمد ترقيماً موحداً `page/pageSize/total` لكل القوائم، ومنتقيات أصناف وأطراف تبحث في الخادم؟ هذا تغيير في عقد الـ API لنحو 12 endpoint. البديل المؤقت: رفع السقوف مع تحذير «تُعرض أول N نتيجة». أوصي بالترقيم، ويستحق ADR.
2. **أنواع الاستجابة في OpenAPI (WEB-12).** هل نبدأ مشروعاً تدريجياً لإضافة DTOs استجابة؟ هذا يمس كل الـ controllers.
3. **الضغط (WEB-11).** يجب التحقق من خادم Hostinger الفعلي. إن لم يضغط، هل نضيف `compression` إلى Node أم نعتمد ملفات مسبقة الضغط؟
4. **سياسة الكاش (WEB-13).** ما مدة القِدم المقبولة للبيانات المرجعية (الحسابات والمستودعات والضرائب)؟ أقترح 5 دقائق، مع إبطال عند التعديل.
5. **فترة سماح لتدوير رمز التحديث (WEB-14).** قرار أمني يخص جلسة review-platform. أقترح 10–30 ثانية.

## 5. ما لم أستطع التحقق منه

- **not verified: disk full.** امتلأ القرص C لأن ملف الترحيل (pagefile) كبر، وهو أيضاً مكان `tmpdir` الخاص بـ MariaDB، فبعض الاستعلامات تفشل بـ Errcode 28. البنود التالية تحتاج API سليماً، وسأعيد تشغيلها حين يتحرر القرص: قياس أحجام القوائم عند السقف (WEB-02، WEB-13)، وإعادة إنتاج WEB-07 بمرتجع مرحّل، وبقاء بيانات A بعد فشل جلب B (WEB-01).
- **أداء الرسم بأحجام كبيرة (not verified: disk full):** توقف توليد البيانات عند نحو 100 سجل لكل نوع بسبب امتلاء القرص C وحد المعدل 100 طلب/دقيقة. لم أقس زمن رسم الجداول ولا شبكة الأسطر مع 500 صنف أو 50 سطراً. الأحجام عند السقف مستنتجة خطياً من الأحجام المقاسة.
- **التحميل الأول على شبكة بطيئة:** لا أداة تقييد للشبكة أو المعالج في المتصفح المدمج، والقياس المحلي (≈200ms) لا يمثّل الإنتاج.
- **ضغط بروكسي Hostinger (WEB-11):** لم أصل إلى بيئة الإنتاج.
- **WEB-07:** من قراءة الكود فقط. لم أرحّل مرتجعاً لأن المستأجر بلا مخزون مرحّل.
- **WEB-01 مع فشل الجلب:** بقاء بيانات A معروضة إذا فشل جلب B مستنتج من سلوك TanStack Query، ولم أُعِد إنتاجه.
- **تبديل الفرع (`setBranch`):** يبطل كل شيء (`AuthContext.tsx:167`) فتظهر بيانات الفرع السابق لحظياً. لم أختبره لأن المستأجر بفرع واحد.
- **اختبارات e2e:** لم أشغّلها، تنفيذاً لتعليمات الجلسة.
- **ملاحظة للجلسات الأخرى:** كوكي `refresh_token` مرتبط بالمضيف `localhost` لا بالمنفذ. لذلك تتشارك كل جلسات المراجعة التي تستخدم `localhost:*` في المتصفح المدمج نفس الكوكي، فقد يدخل بعضها إلى مستأجر جلسة أخرى. هذه مشكلة بيئة الاختبار فقط، لأن الإنتاج أصل واحد. الحل: استخدام `<name>.localhost:<port>`.

---

**الملخص:**
1. العدد حسب الخطورة: critical 1 · high 2 · medium 10 · low 8 (المجموع 21).
2. WEB-01: الكاش لا يُفرَّغ عند الخروج أو تبديل المستأجر، فتظهر بيانات مستأجر لآخر (مُعاد إنتاجه).
3. WEB-02: سقوف قوائم ثابتة (500/300/200) بلا ترقيم، فالصنف 501 والفواتير الأقدم تختفي وتصبح غير قابلة للاختيار بصمت.
4. WEB-03: فشل الجلب يُعرض كقائمة فارغة، بلا رسالة ولا إعادة محاولة ولا تعافٍ بعد عودة الخادم.
5. الحزمة 2.06 MB في ملف واحد بلا تقسيم ولا ضغط من Node (WEB-10/11)، والعميل المولَّد بلا أنواع (WEB-12).
