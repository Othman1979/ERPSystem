# دليل النشر

المرجع: ADR-010 (المرحلة 10). الدليل عام، يصلح لـ Hostinger Cloud ولخادم VPS، لأن التطبيق لا يعتمد على لوحة
استضافة بعينها (§3.1). خطوات لوحة Hostinger نفسها، مثل إنشاء تطبيق Node، تُطبَّق حسب لوحتها.

قائمة مختصرة بالترتيب لأول نشر: `first-deploy-checklist.md`. هذا الملف هو التفاصيل.

## المتطلبات
- **Node.js 24 LTS** وpnpm 10. النسخة مثبتة في `.nvmrc` (`24`) وفي `engines` في `package.json`. اختر 24 في
  لوحة Node، أو `nvm use` في المستودع.
- **MariaDB بنسخة LTS بين 10.11 و11.8** (ADR-019). CI يختبر طرفي هذا المدى: `mariadb:10.11` و`mariadb:11.8`.
  - 10.6 انتهى دعمها في تموز 2026، فلم تعد مقبولة.
  - `preflight` يفحصها (`database-version`): ليست MariaDB، أو أقدم من 10.11، خطأ في الإنتاج. أحدث من 11.8
    تحذير.
  - اكتب نسخة الاستضافة الفعلية (من مخرجات `preflight`، سطر `VERSION()`) في ADR-019 عند أول نشر. إذا كانت خارج
    المدى، فأضفها إلى مصفوفة CI قبل النشر.
  - على 11.6.2 وما بعده: الإعداد `SESSION_INIT_SQL` يتكفل بـ snapshot isolation، و`preflight` يتحقق منه.
- **الأداتان `mysqldump` و`mysql`** (أو `mariadb-dump` و`mariadb`)، للنسخ الاحتياطي. `preflight` يفحصهما.
- **نطاق مع SSL** من لوحة الاستضافة، **وCron** للأوامر الدورية.
- **نسخة واحدة فقط من الـ API.** حدود المحاولات (ADR-011) في ذاكرة العملية: نسختان تعنيان حدّين منفصلين،
  فيتضاعف ما يُسمح به. لا تشغّل أكثر من عملية ولا وضع cluster في لوحة Node.

## القاعدة
- **قاعدتان تُنشآن من لوحة الاستضافة:**
  - القاعدة الأساسية؛
  - قاعدة مؤقتة لاختبار الاستعادة، اسمها يحتوي `restore`، مثلاً `u123_erp_restore`.
  - `backup-verify` يفرّغها ولا ينشئ قواعد، لأن مستخدم الاستضافة لا يملك هذه الصلاحية عادة.
- **مستخدم القاعدة:** مستخدم اللوحة بكلمة مرور. الإنتاج يرفض الإقلاع بالمستخدم `root` أو بكلمة مرور فارغة.
- **الترتيب `utf8mb4_unicode_ci`:**
  - **أنشئ القاعدتين في اللوحة بـ `utf8mb4` و`utf8mb4_unicode_ci`.** الجداول تُنشأ به صراحة، والـ migration
    `20261113164500_db_review_indexes` تبدأ بـ `ALTER DATABASE` لتجعله الافتراضي للقاعدة. إن كانت القاعدة به
    من البداية، فهذه الجملة لا تغيّر شيئاً.
  - إن لم تسمح اللوحة بالاختيار، فنفّذ قبل `migrate deploy`، من phpMyAdmin أو `mysql`، بمستخدم القاعدة:
    ```sql
    ALTER DATABASE <القاعدة> CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    ```
  - التطبيق يفتح كل اتصال بـ `utf8mb4_unicode_ci` صراحة (`prisma.service.ts`). `preflight` يفحص القاعدة
    والجلسة معاً (`charset`)، وأي اختلاف خطأ في الإنتاج.
- **صلاحية ALTER على القاعدة:**
  - مستخدم الـ migrations يحتاجها لهذه الخطوة. لوحات الاستضافة تمنحها عادةً مع كل الصلاحيات على قاعدة المستخدم.
  - إن فشلت `migrate deploy` بالخطأ 1044، فـ `ALTER DATABASE` أول جملة في الـ migration، ولم يتغير شيء بعد.
  - اطلب الصلاحية من دعم الاستضافة، ثم:
    ```bash
    pnpm --filter api exec prisma migrate resolve --rolled-back 20261113164500_db_review_indexes
    pnpm --filter api exec prisma migrate deploy
    ```
- **أي migration فاشلة** (`migrate deploy` يتوقف، و`preflight` يذكرها في `migrations: failed`):
  1. اقرأ الخطأ وأصلح سببه: صلاحية، أو بيانات تخالف قيداً جديداً، أو مهلة.
  2. **MariaDB لا تعكس جمل DDL:** الجمل التي نُفّذت قبل الخطأ باقية. قارن `migration.sql` بحالة القاعدة.
     - إن كان الخطأ في أول جملة، فلم يتغير شيء.
     - وإلا فأعد ما تغيّر يدوياً، أو استعد النسخة المأخوذة قبل التحديث (`disaster-recovery.md`).
  3. علّمها غير مطبّقة، ثم أعد التشغيل:
     ```bash
     pnpm --filter api exec prisma migrate resolve --rolled-back <اسم المجلد>
     pnpm --filter api exec prisma migrate deploy
     ```
  4. **لا تعدّل ملف migration طُبّق في أي قاعدة.** إن احتاج التصحيح، فهو migration جديدة.

## المجلدات
| المجلد | المكان | ملاحظة |
|---|---|---|
| الكود | مثلاً `~/erp` | المستودع كاملاً |
| المرفقات `STORAGE_DIR` | خارج `public_html`، مثلاً `~/erp-data/storage` | يدخل في النسخ الاحتياطي |
| النسخ `BACKUP_DIR` | خارج `public_html` وخارج `STORAGE_DIR`، مثلاً `~/erp-data/backups` | `preflight` يرفض التداخل |
| السجلات | `~/erp-data/logs` | لأوامر Cron، و`ERROR_LOG_FILE` |

أنشئها مرة واحدة، والنسخ لصاحب الحساب وحده (فيها بيانات كل المستأجرين):
```bash
mkdir -p ~/erp-data/{storage,backups,logs}
chmod 700 ~/erp-data/backups
```
- اكتب المسارات في `.env` **مطلقة** (`/home/<user>/...`). المسار النسبي يُحسب من مجلد العمل، وسطر Cron قد
  يغيّره. `preflight` يحذّر منه (`paths`).
- `preflight` يتحقق أن مجلد `ERROR_LOG_FILE` قابل للكتابة (`error-log`).

## مسارات الأدوات
أوامر Cron تعمل بـ `PATH` قصير (غالباً `/usr/bin:/bin`)، فقد لا تجد `node` أو أداة التفريغ. نفّذ مرة واحدة
بعد الدخول بـ SSH:
```bash
which node mysqldump mysql      # أو: which node mariadb-dump mariadb
```
- مسارا أداتي القاعدة يدخلان `.env`: `MYSQLDUMP_PATH` و`MYSQL_PATH`.
- مجلد `node` يدخل سطر `PATH` أعلى ملف Cron، أو يُكتب مساره المطلق في كل سطر (انظر «أوامر Cron»).

## ملف `apps/api/.env` في الإنتاج
- **أنشئه قبل التثبيت.** `prisma generate` (بعد التثبيت تلقائياً) لا يحتاج القاعدة، لكن كل ما بعده يحتاجها:
  `migrate deploy` و`db seed` والتطبيق وأوامر Cron. دون `DATABASE_URL` تتوقف أوامر prisma برسالة
  `datasource.url property is required`.
- كل المتغيرات مشروحة في `apps/api/.env.example`. الإلزامي منها في الإنتاج، والتطبيق يرفض الإقلاع دونه:

```
NODE_ENV=production
DATABASE_URL="mysql://<user>:<password>@localhost:3306/<db>"
CORS_ORIGIN="https://<النطاق>"            # بالضبط: أحرف صغيرة، دون مسار ولا / في آخره
JWT_ACCESS_SECRET="<48 حرفاً عشوائياً على الأقل>"
EINVOICE_ENC_KEY="<32 بايتاً عشوائياً base64>"   # احفظه خارج الخادم أيضاً: فقده = فقد أسرار JoFotara
EINVOICE_WORKER=off
TRUST_PROXY=loopback                      # افتراضياً: بروكسي على الجهاز نفسه. تحقق منه (النشر الأول)
# المنفذ: إن أعطت الاستضافة PORT استُخدم تلقائياً ما دام API_PORT فارغاً؛ وإلا API_PORT (الافتراضي 3001)
WEB_DIST_DIR=../web/dist                  # الـ API يقدّم الواجهة على النطاق نفسه
STORAGE_DIR=/home/<user>/erp-data/storage
BACKUP_DIR=/home/<user>/erp-data/backups
MYSQLDUMP_PATH=/usr/bin/mysqldump         # من مخرجات which
MYSQL_PATH=/usr/bin/mysql                 # من مخرجات which
BACKUP_VERIFY_DATABASE_URL="mysql://<user>:<password>@localhost:3306/<القاعدة المؤقتة>"
BACKUP_ENCRYPTION_KEY="<32 بايتاً عشوائياً base64>"   # احفظه خارج الخادم: فقده = فقد كل النسخ الاحتياطية
ERROR_LOG_FILE=/home/<user>/erp-data/logs/errors-fallback.log   # الأخطاء التي لم تُكتب في القاعدة
ALERT_WEBHOOK_URL="https://..."           # اختياري
```

- **ما يرفضه الإنتاج** (الرسالة تسمّي المتغير):
  - سرّ فيه `change-me` أو `dev-only` أو `example`، أي قيمة منسوخة من ملف مثال؛
  - `DATABASE_URL` بالمستخدم `root` أو بلا كلمة مرور؛
  - `NODE_ENV=test` على أي خادم: يفتح مسارات الاختبار، فيُرفض خارج تشغيل Jest.
- `preflight` يعدّ `NODE_ENV` غير `production` خطأً حين يكون `CORS_ORIGIN` نطاقاً عاماً (`environment`).

**توليد الأسرار:** نفّذ الأمرين على جهازك، ولا تلصق الناتج في أي محادثة أو تذكرة.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## النشر الأول
قبل البدء: القاعدتان بـ utf8mb4 (§القاعدة)، والمجلدات، ومسارات الأدوات، و`apps/api/.env`.

الترتيب: **التثبيت، ثم التوليد، ثم البناء، ثم الـ migrations، ثم البذور.** كلها من مجلد المستودع `~/erp`.

1. **التثبيت.** `--prod=false` ضروري لأن أدوات البناء (nest وtypescript وprisma وtsx وvite) من
   devDependencies، واللوحات التي تضبط `NODE_ENV=production` تتخطاها بدونه:
   ```bash
   cd ~/erp && pnpm install --frozen-lockfile --prod=false
   ```
2. **توليد عميل Prisma.** المجلد `apps/api/src/generated` لا يدخل Git، فلا يحدّثه `git pull`. عميل قديم
   يبني بلا خطأ ثم يفشل وقت التشغيل:
   ```bash
   pnpm --filter api prisma:generate
   ```
   - `prisma:generate` هو `prisma generate` ثم ختم الـ schema (`scripts/prisma-stamp.mjs`): بصمة sha256 لـ
     `prisma/schema.prisma` بجانب العميل. البناء ينسخها إلى `dist`، و`preflight` يقارنها بالـ schema الحالي
     (`prisma-client`): غيابها أو اختلافها خطأ في الإنتاج.
   - `pnpm --filter api exec prisma generate` وحده لا يكتب البصمة، فيبقى `preflight` على البصمة القديمة.
     استعمل `prisma:generate`.
3. **البناء:**
   ```bash
   pnpm build
   ```
4. **الـ migrations ثم البذور** (الباقات والعملات والدول والأدوار):
   ```bash
   pnpm --filter api exec prisma migrate deploy
   pnpm --filter api exec prisma db seed
   ```
5. **الفحص.** يجب ألا يظهر أي `error`:
   ```bash
   cd ~/erp/apps/api && node dist/jobs/cli.js preflight
   ```
6. **التشغيل.** أمر البدء: `node --max-old-space-size=512 dist/main.js` (هو `pnpm --filter api start`)، ومجلد
   العمل `apps/api`.
   - سقف الـ heap (PLAT-18): 512 MB تكفي، فالعملية تثبت قرب 650 MB من الذاكرة الكلية بعد حمل 50 طلباً متزامناً.
     على استضافة بحد 1 GB يبقى هامش لأوامر Cron. إن لم تقبل اللوحة خيارات Node فاضبط
     `NODE_OPTIONS=--max-old-space-size=512`.
   - في لوحة Hostinger: هذا هو ملف بدء تطبيق Node. **نسخة واحدة** (§المتطلبات).
   - على VPS: مدير عمليات، مثل systemd.
   - **تحقق من البروكسي:** بعد أول طلبات افتح سجل التطبيق. إن ظهر تحذير `TrustProxy` فالبروكسي لا يأتي من
     الجهاز نفسه. اضبط `TRUST_PROXY` على عنوانه أو شبكته (ADR-011)، مثل `loopback, 10.0.0.0/8`، وأعد التشغيل.
     دون ذلك يتشارك كل العملاء حداً واحداً للمحاولات.
7. **التسجيل:** افتح `https://<النطاق>` وسجّل حساب المالك. ثم امنحه إدارة المنصة:
   ```bash
   node dist/jobs/cli.js grant-platform-admin <البريد>
   ```
8. **أوامر Cron**، كلها من مجلد `apps/api`. ضع أعلى الملف سطر `PATH` بمجلد `node` من مخرجات `which node`:
   ```
   PATH=<مجلد node>:/usr/local/bin:/usr/bin:/bin
   30 0 * * *  cd ~/erp/apps/api && node dist/jobs/cli.js tenant-status   >> ~/erp-data/logs/jobs.log 2>&1
   * * * * *   cd ~/erp/apps/api && node dist/jobs/cli.js einvoice-send   > /dev/null 2>> ~/erp-data/logs/jobs.log
   15 2 * * *  cd ~/erp/apps/api && node dist/jobs/cli.js backup          >> ~/erp-data/logs/jobs.log 2>&1
   5 * * * *   cd ~/erp/apps/api && node dist/jobs/cli.js error-digest    >> ~/erp-data/logs/jobs.log 2>&1
   15 3 * * *  cd ~/erp/apps/api && node dist/jobs/cli.js stock-verify    >> ~/erp-data/logs/jobs.log 2>&1
   45 3 * * *  cd ~/erp/apps/api && node dist/jobs/cli.js purge-expired   >> ~/erp-data/logs/jobs.log 2>&1
   30 4 1 * *  cd ~/erp/apps/api && node dist/jobs/cli.js integrity-check >> ~/erp-data/logs/jobs.log 2>&1
   0 5 * * 0   mv -f ~/erp-data/logs/jobs.log ~/erp-data/logs/jobs.log.1
   # اختياري: اختبار الاستعادة الشهري آلياً (يبقى السجل اليدوي في backup-restore.md)
   0 5 2 * *   cd ~/erp/apps/api && node dist/jobs/cli.js backup-verify latest >> ~/erp-data/logs/jobs.log 2>&1
   ```
   - **لوحة لا تقبل سطر `PATH`** (نموذج Cron بأمر واحد لكل مهمة، كما في hPanel): اكتب مسار `node` المطلق في
     كل أمر، مثل `cd ~/erp/apps/api && /path/to/node dist/jobs/cli.js backup >> ...`.
   - **`einvoice-send` كل دقيقة:** مخرجات النجاح إلى `/dev/null` كي لا يكبر السجل بسطر كل دقيقة. الفشل يكتب
     رسالته في stderr ويخرج برمز 1، فيصل إلى `jobs.log`، ويُسجَّل في تبويب «الأخطاء».
   - **تدوير السجل أسبوعياً** (سطر `mv` يوم الأحد): يبقى أسبوعان، الحالي و`jobs.log.1`. الأمر الذي يعمل لحظة
     التدوير يكمل في `jobs.log.1`، والتالي يبدأ ملفاً جديداً. `errors-fallback.log` يدوّره `error-digest` بنفسه.
   - **`stock-verify` يومياً:** الكميات والقيمة ومطابقة حساب المخزون لكل المستأجرين. يخرج برمز 1 عند أي فرق.
   - **`integrity-check` شهرياً وبعد كل استعادة** (ADR-019): المراجع بلا FK والترتيب.
   - **`backup-verify latest`** شهرياً، يدوياً أو بالسطر الاختياري. التفاصيل في `backup-restore.md`. يحتاج
     `BACKUP_VERIFY_DATABASE_URL`.
   - **اتصالات القاعدة:**
     - كل عملية تفتح pool خاصاً بها، ويبقي الـ pool كل اتصالاته مفتوحة.
     - التطبيق يأخذ `DB_POOL_SIZE` (10 افتراضياً)، وكل أمر Cron يأخذ 2، إلا إذا مرّر سطره قيمة:
       `DB_POOL_SIZE=4 node dist/jobs/cli.js backup`.
     - مجموع pool التطبيق وأوامر Cron التي قد تعمل معاً يجب أن يبقى تحت `max_user_connections` في الاستضافة.
       مثال: 10 + 2 × 3 = 16. `preflight` يقرأ الحد ويحذّر إن كان أقل (`connections`).
9. **مراقبة التشغيل:** مراقب خارجي مجاني على `https://<النطاق>/api/v1/health`، مثل UptimeRobot، كل 5
   دقائق.
   - `/health` يتحقق أن القاعدة **تكتب** وتستعمل مجلدها المؤقت (القرص الممتلئ يرد 503)، بمهلة ثانيتين.
   - `/health/live` لا يلمس القاعدة: لفحص «العملية حيّة» في مدير العمليات، كي لا يُعاد تشغيلها بسبب عطل القاعدة.
10. **فحص يدوي سريع:**
    - الدخول؛
    - ميزان المراجعة لشركة تجريبية متوازن؛
    - طباعة فاتورة PDF؛
    - تبويب «الأخطاء» في لوحة المنصة.
11. **أول نسخة احتياطية واختبارها**، قبل أن تدخل أي شركة بياناتها:
    ```bash
    node dist/jobs/cli.js backup
    node dist/jobs/cli.js backup-verify latest
    ```
    - يجب أن ينجح الاثنان. سجّل النتيجة في جدول `backup-restore.md`.
    - **احفظ `BACKUP_ENCRYPTION_KEY` و`EINVOICE_ENC_KEY` خارج الخادم** (مدير كلمات المرور). دونهما لا تُستعاد
      نسخة، ولا تُفك أسرار JoFotara.
12. **سجّل النسخ:**
    - نسخة MariaDB (سطر `database` في `preflight`) في ADR-019، كما يطلب قراره؛
    - ونسخة Node (`node -v`)، والـ commit المنشور (`git rev-parse --short HEAD`).

## تحديث إصدار
البناء يفرّغ `dist` ثم يعيد كتابته. في هذه الدقائق تفشل ملفات الواجهة عند المتصفحات المفتوحة، ويفشل أي أمر
Cron يبدأ. لذلك يجري التحديث في نافذة صيانة قصيرة.

الترتيب: **أوقف التطبيق، ثم `ledger:check`، ثم الـ migrations، ثم التوليد، ثم البناء، ثم التشغيل.**

1. **أوقف أوامر Cron مؤقتاً**، بتعليق أسطرها، **وخذ نسخة:** `node dist/jobs/cli.js backup`.
2. **السحب والتثبيت**، والتطبيق القديم ما زال يعمل (يقرأ `dist` فقط):
   ```bash
   cd ~/erp && git pull && pnpm install --frozen-lockfile --prod=false
   ```
3. **أوقف التطبيق.**
4. **فحص بيانات القيود** (ADR-014). للقراءة فقط، لا يكتب شيئاً، **ويجب أن يخرج نظيفاً**:
   ```bash
   pnpm --filter api ledger:check
   ```
   - رمز 1 يعني قيوداً معكوسة مرتين: الـ migration `20261113163739_journal_reversal_unique` تفشل بوجودها.
     يصحّحها المحاسب بقيود قبل المتابعة (المرحّل لا يُعدَّل).
   - الأقسام الأخرى في التقرير تُراجع مع المحاسب، ولا تمنع المتابعة.
5. **الـ migrations:**
   ```bash
   pnpm --filter api exec prisma migrate deploy
   ```
   - إن فشلت إحداها: §القاعدة، «أي migration فاشلة».
   - التطبيق القديم يقرأ أعمدة قد تحذفها migration جديدة. مثال: `20261113164500_db_review_indexes` تحذف
     `reversal_of_id`، فتفشل الفواتير وأذون البضاعة عنده حتى إعادة التشغيل. لذلك لا تُطبَّق migration والتطبيق
     القديم يعمل.
   - **الموجة 3E (الترقيم وقراءة الفروع):** ثلاث migrations إضافية، لكن اثنتين منها تقفلان جداول كبيرة،
     فتُطبَّق كلها والتطبيق متوقف (كما في هذه الخطوة)، وفي وقت قليل الاستخدام:
     - `20261114120000_journal_lines_entry_cover_idx`: فهرس جديد على `journal_lines`. يُبنى في مكانه
       (`LOCK=NONE`) لكنه يأخذ قفل بيانات وصفية (metadata lock) لحظة البدء والانتهاء، فينتظر خلف أي معاملة
       مفتوحة على الجدول، وتنتظر خلفه كل كتابة جديدة. لهذا يُطبَّق والتطبيق متوقف.
     - `20261114130000_paging_indexes_einvoice_branch`: عمود وفهارس، ثم `UPDATE` يملأ
       `einvoice_submissions.branch_id` (أقفال صفوف على الجدول كله حتى انتهاء الجملة)، ثم مفتاح أجنبي
       جديد. إضافة المفتاح الأجنبي مع `foreign_key_checks=1` تنسخ الجدول (ALGORITHM=COPY) فتمنع الكتابة
       عليه، ومنها ترحيل الفواتير التي تكتب صف outbox. الجدول صغير عادة (صف لكل فاتورة مرسلة)، لكن الكتابة
       متوقفة طوال النسخ.
     - `20261114140000_journal_lines_entry_date`: يضيف `journal_lines.entry_date` (فوري)، ثم `UPDATE`
       واحد يملؤه من القيود (أقفال صفوف على **كل** سطور القيود حتى ينتهي)، ثم `NOT NULL` (إعادة بناء الجدول
       في مكانه)، ثم فهرسين جديدين، ثم يملأ فرع قيود التسويات المخزنية الفارغ. على `erp_test` (543 ألف سطر،
       MariaDB 10.4 على جهاز تطوير) استغرقت 39 ثانية. قدّر الوقت على نسخة من قاعدة الإنتاج قبل النافذة.
     - بعدها شغّل `job:integrity-check` و`stock:verify` كالمعتاد.
   - **المرحلة 13 (`20261115130000_phase13_receiving_billing_issues`، ADR-026):** تُطبَّق والتطبيق متوقف، في
     نافذة صيانة:
     - **تعيد بناء خمسة جداول** (نسخ الجدول، فلا كتابة عليه طوال النسخ): `purchase_invoice_lines` و
       `purchase_return_lines` (توسيع `unit_cost` إلى `DECIMAL(18,6)`)، و`goods_notes` و`goods_note_lines`
       و`purchase_invoices` (أعمدة جديدة مع مفاتيح أجنبية جديدة). قدّر الوقت على نسخة من قاعدة الإنتاج.
     - **المدى:** `DECIMAL(18,6)` يترك 12 خانة صحيحة بدل 15. قبل النافذة تأكد أن لا سعر وحدة يتجاوزها،
       وإلا فشل `ALTER` في الوضع الصارم ولم يتغير شيء:
       ```sql
       SELECT 'purchase_invoice_lines' AS t, COUNT(*) AS n FROM purchase_invoice_lines WHERE unit_cost >= 1000000000000
       UNION ALL SELECT 'purchase_return_lines', COUNT(*) FROM purchase_return_lines WHERE unit_cost >= 1000000000000;
       ```
       يجب أن يكون الناتج صفراً في الجدولين. الواجهة البرمجية ترفض من الآن أي سعر وحدة فوق 12 خانة صحيحة (400).
     - بعدها شغّل `job:integrity-check` (فحوص الاستلام والفوترة والصرف الجديدة) و`stock:verify`.
6. **توليد عميل Prisma**، ثم **البناء:**
   ```bash
   pnpm --filter api prisma:generate
   pnpm build
   ```
   التثبيت في الخطوة 2 يولّد العميل أيضاً (postinstall)، لكن هذه الخطوة تضمنه حتى لو لم يتغير شيء في الحزم.
7. **`preflight`**، ثم شغّل التطبيق، **وأعد أوامر Cron.**
8. **التحقق:** الإصدار الجديد يظهر في المتصفح فوراً، لأن `index.html` لا يُخزَّن مؤقتاً. من فتح الصفحة أثناء
   البناء يعيد تحميلها.
   - لتحديث بلا انقطاع لاحقاً: ابنِ في مجلد إصدار جديد، ثم بدّل إليه وأعد التشغيل.

**التراجع:**
- ارجع إلى الإصدار السابق (`git checkout <الوسم السابق>`)، ثم ولّد العميل وابنِ من جديد وأعد التشغيل.
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
