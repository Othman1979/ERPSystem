# دليل النشر

المرجع: ADR-010 (المرحلة 10). الدليل عام، يصلح لـ Hostinger Cloud ولخادم VPS، لأن التطبيق لا يعتمد على لوحة
استضافة بعينها (§3.1). خطوات لوحة Hostinger نفسها، مثل إنشاء تطبيق Node، تُطبَّق حسب لوحتها.

## المتطلبات
- Node.js 24 LTS وpnpm 10.
- **MariaDB بنسخة LTS بين 10.11 و11.8** (ADR-019). CI يختبر طرفي هذا المدى: `mariadb:10.11` و`mariadb:11.8`.
  - 10.6 انتهى دعمها في تموز 2026، فلم تعد مقبولة.
  - اكتب نسخة الاستضافة الفعلية (من مخرجات `preflight`، سطر `VERSION()`) في ADR-019 عند أول نشر. إذا كانت خارج
    المدى، فأضفها إلى مصفوفة CI قبل النشر.
  - على 11.6.2 وما بعده: الإعداد `SESSION_INIT_SQL` يتكفل بـ snapshot isolation، و`preflight` يتحقق منه.
  - **الترتيب `utf8mb4_unicode_ci`:** الجداول تُنشأ به صراحة، والـ migration `20261113164500_db_review_indexes`
    تجعله الافتراضي للقاعدة أيضاً (`ALTER DATABASE`). أنشئ القاعدة في اللوحة بـ utf8mb4 إن سمحت بالاختيار.
  - **صلاحية ALTER على القاعدة:**
    - مستخدم الـ migrations يحتاجها لهذه الخطوة. لوحات الاستضافة تمنحها عادةً مع كل الصلاحيات على قاعدة المستخدم.
    - إن فشلت `migrate deploy` بالخطأ 1044، فـ `ALTER DATABASE` أول جملة في الـ migration، ولم يتغير شيء بعد.
    - اطلب الصلاحية من دعم الاستضافة، ثم:
      ```bash
      pnpm prisma migrate resolve --rolled-back 20261113164500_db_review_indexes
      pnpm prisma migrate deploy
      ```
- **الأداتان `mysqldump` و`mysql`** (أو `mariadb-dump` و`mariadb`)، للنسخ الاحتياطي. `preflight` يفحصهما.
- **نطاق مع SSL** من لوحة الاستضافة، **وCron** للأوامر الدورية.
- **قاعدتان تُنشآن من لوحة الاستضافة:**
  - القاعدة الأساسية؛
  - قاعدة مؤقتة لاختبار الاستعادة، اسمها يحتوي `restore`، مثلاً `u123_erp_restore`.
  - `backup-verify` يفرّغها ولا ينشئ قواعد، لأن مستخدم الاستضافة لا يملك هذه الصلاحية عادة.

## المجلدات
| المجلد | المكان | ملاحظة |
|---|---|---|
| الكود | مثلاً `~/erp` | المستودع كاملاً |
| المرفقات `STORAGE_DIR` | خارج `public_html`، مثلاً `~/erp-data/storage` | يدخل في النسخ الاحتياطي |
| النسخ `BACKUP_DIR` | خارج `public_html` وخارج `STORAGE_DIR`، مثلاً `~/erp-data/backups` | `preflight` يرفض التداخل |
| السجلات | `~/erp-data/logs` | لأوامر Cron |

## ملف `apps/api/.env` في الإنتاج
كل المتغيرات مشروحة في `apps/api/.env.example`. الإلزامي منها في الإنتاج، والتطبيق يرفض الإقلاع دونه:

```
NODE_ENV=production
DATABASE_URL="mysql://<user>:<password>@localhost:3306/<db>"
CORS_ORIGIN="https://<النطاق>"            # بالضبط: أحرف صغيرة، دون مسار ولا / في آخره
JWT_ACCESS_SECRET="<48 حرفاً عشوائياً على الأقل>"
EINVOICE_ENC_KEY="<32 بايتاً عشوائياً base64>"   # احفظه خارج الخادم أيضاً: فقده = فقد أسرار JoFotara
EINVOICE_WORKER=off
TRUST_PROXY=loopback                      # افتراضياً: بروكسي على الجهاز نفسه. تحقق منه (الخطوة 4)
# المنفذ: إن أعطت الاستضافة PORT استُخدم تلقائياً؛ وإلا API_PORT (الافتراضي 3001)
WEB_DIST_DIR=../web/dist                  # الـ API يقدّم الواجهة على النطاق نفسه
STORAGE_DIR=/home/<user>/erp-data/storage
BACKUP_DIR=/home/<user>/erp-data/backups
MYSQLDUMP_PATH=mysqldump
MYSQL_PATH=mysql
BACKUP_VERIFY_DATABASE_URL="mysql://<user>:<password>@localhost:3306/<القاعدة المؤقتة>"
ALERT_WEBHOOK_URL="https://..."           # اختياري
```

**توليد الأسرار:** نفّذ الأمرين على جهازك، ولا تلصق الناتج في أي محادثة أو تذكرة.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## النشر الأول
1. **التثبيت والبناء.** `--prod=false` ضروري لأن أدوات البناء (nest وtypescript وprisma وtsx وvite) من
   devDependencies، واللوحات التي تضبط `NODE_ENV=production` تتخطاها بدونه:
   ```bash
   cd ~/erp && pnpm install --frozen-lockfile --prod=false && pnpm build
   ```
2. **القاعدة:**
   ```bash
   cd apps/api && pnpm prisma migrate deploy && pnpm prisma db seed
   ```
3. **الفحص.** يجب ألا يظهر أي `error`:
   ```bash
   node dist/jobs/cli.js preflight
   ```
4. **التشغيل.** أمر البدء: `node dist/main.js`، ومجلد العمل `apps/api`.
   - في لوحة Hostinger: هذا هو ملف بدء تطبيق Node.
   - على VPS: مدير عمليات، مثل systemd.
   - **تحقق من البروكسي:** بعد أول طلبات افتح سجل التطبيق. إن ظهر تحذير `TrustProxy` فالبروكسي لا يأتي من
     الجهاز نفسه. اضبط `TRUST_PROXY` على عنوانه أو شبكته (ADR-011)، مثل `loopback, 10.0.0.0/8`، وأعد التشغيل.
     دون ذلك يتشارك كل العملاء حداً واحداً للمحاولات.
5. **التسجيل:** افتح `https://<النطاق>` وسجّل حساب المالك. ثم امنحه إدارة المنصة:
   ```bash
   node dist/jobs/cli.js grant-platform-admin <البريد>
   ```
6. **أوامر Cron**، كلها من مجلد `apps/api`:
   ```
   30 0 * * *  cd ~/erp/apps/api && node dist/jobs/cli.js tenant-status >> ~/erp-data/logs/jobs.log 2>&1
   * * * * *   cd ~/erp/apps/api && node dist/jobs/cli.js einvoice-send  >> ~/erp-data/logs/jobs.log 2>&1
   15 2 * * *  cd ~/erp/apps/api && node dist/jobs/cli.js backup        >> ~/erp-data/logs/jobs.log 2>&1
   5 * * * *   cd ~/erp/apps/api && node dist/jobs/cli.js error-digest  >> ~/erp-data/logs/jobs.log 2>&1
   ```
   - اختبار الاستعادة شهرياً، يدوياً: `node dist/jobs/cli.js backup-verify latest`. التفاصيل في
     `backup-restore.md`.
   - فحص المراجع بلا FK والترتيب شهرياً وبعد كل استعادة: `node dist/jobs/cli.js integrity-check` (ADR-019).
   - **اتصالات القاعدة:**
     - كل عملية تفتح pool خاصاً بها، ويبقي الـ pool كل اتصالاته مفتوحة.
     - التطبيق يأخذ `DB_POOL_SIZE` (10 افتراضياً)، وكل أمر Cron يأخذ 2، إلا إذا مرّر سطره قيمة:
       `DB_POOL_SIZE=4 node dist/jobs/cli.js backup`.
     - مجموع pool التطبيق وأوامر Cron التي قد تعمل معاً يجب أن يبقى تحت `max_user_connections` في الاستضافة.
       مثال: 10 + 2 × 3 = 16.
7. **مراقبة التشغيل:** مراقب خارجي مجاني على `https://<النطاق>/api/v1/health`، مثل UptimeRobot، كل 5
   دقائق.
8. **فحص يدوي سريع:**
   - الدخول؛
   - ميزان المراجعة لشركة تجريبية متوازن؛
   - طباعة فاتورة PDF؛
   - تبويب «الأخطاء» في لوحة المنصة.

## تحديث إصدار
البناء يفرّغ `dist` ثم يعيد كتابته. في هذه الدقائق تفشل ملفات الواجهة عند المتصفحات المفتوحة، ويفشل أي أمر
Cron يبدأ. لذلك يجري التحديث في نافذة صيانة قصيرة:
1. **أوقف أوامر Cron مؤقتاً**، بتعليق أسطرها، **وخذ نسخة:** `node dist/jobs/cli.js backup`.
2. **السحب والبناء:**
   ```bash
   cd ~/erp && git pull && pnpm install --frozen-lockfile --prod=false && pnpm build
   ```
3. **أوقف التطبيق، ثم شغّل الـ migrations:**
   ```bash
   cd apps/api && pnpm prisma migrate deploy
   ```
   - التطبيق القديم يقرأ أعمدة قد تحذفها migration جديدة. مثال: `20261113164500_db_review_indexes` تحذف
     `reversal_of_id`، فتفشل الفواتير وأذون البضاعة عنده حتى إعادة التشغيل. لذلك لا تُطبَّق migration والتطبيق
     القديم يعمل.
4. **`preflight`**، ثم شغّل التطبيق، **وأعد أوامر Cron.**
5. **التحقق:** الإصدار الجديد يظهر في المتصفح فوراً، لأن `index.html` لا يُخزَّن مؤقتاً. من فتح الصفحة أثناء
   البناء يعيد تحميلها.
   - لتحديث بلا انقطاع لاحقاً: ابنِ في مجلد إصدار جديد، ثم بدّل إليه وأعد التشغيل.

**التراجع:**
- ارجع إلى الإصدار السابق (`git checkout <الوسم السابق>`)، ثم ابنِ من جديد وأعد التشغيل.
- **الـ migrations لا تُعكس:** إن كان الإصدار الجديد قد غيّر القاعدة، فالتراجع عنها استعادة النسخة
  المأخوذة في الخطوة 1 (`disaster-recovery.md`).

## تغيير الأسرار
- **`JWT_ACCESS_SECRET`:** تغييره يرفض فوراً كل رمز دخول وُقّع بالسر القديم، ومنها أي رمز مزوّر.
  - **لكنه لا يُخرج أحداً:** رموز التجديد مستقلة عنه، فتتجدد الجلسات وحدها.
  - لإخراج مستخدم بعينه، اتبع `disaster-recovery.md` §5.
- **`EINVOICE_ENC_KEY`:** لا تغيّره. أسرار JoFotara المحفوظة مختومة به، وتغييره يعني إعادة إدخال سرّ كل
  شركة. إن تسرّب، غيّره ثم اطلب من كل شركة إعادة إدخال سرّها، وغيّر الأسرار عند JoFotara نفسها.
- **كلمة مرور القاعدة:** غيّرها في `DATABASE_URL` و`BACKUP_VERIFY_DATABASE_URL`، ثم `preflight` وإعادة
  التشغيل.
