# قائمة أول نشر (Hostinger)

قائمة مختصرة بالترتيب. التفاصيل والأسباب في `deploy.md`، والقسم مذكور بجانب كل خطوة. لا تكتب هنا أي سرّ ولا
كلمة مرور: الأسرار في `apps/api/.env` على الخادم، ونسخة منها في مدير كلمات المرور فقط.

## قبل البدء
- [ ] الخطة فيها SSH وCron وNode 24 (Hostinger Cloud أو VPS). الخطة المشتركة دونها لا تكفي. (`deploy.md`
      §المتطلبات)
- [ ] Node 24 مختار في لوحة Node (`.nvmrc`)، وpnpm 10 متاح. (§المتطلبات)
- [ ] القاعدة **MariaDB 10.11 أو أحدث** (LTS بين 10.11 و11.8). **MySQL غير مدعومة.** (§المتطلبات)
- [ ] نطاق مع SSL، وCron مفعّل. (§المتطلبات)

## القاعدة والمجلدات والإعدادات
- [ ] أنشئ القاعدة الأساسية من اللوحة بـ `utf8mb4` / `utf8mb4_unicode_ci`، ومعها مستخدمها بكلمة مرور (ليس
      `root`). (§القاعدة)
- [ ] أنشئ القاعدة المؤقتة لاختبار الاستعادة، اسمها يحتوي `restore`، بالترتيب نفسه. (§القاعدة)
- [ ] إن لم تسمح اللوحة باختيار الترتيب: `ALTER DATABASE ... utf8mb4_unicode_ci` على القاعدتين. (§القاعدة)
- [ ] `mkdir -p ~/erp-data/{storage,backups,logs}` ثم `chmod 700 ~/erp-data/backups`. (§المجلدات)
- [ ] `which node mysqldump mysql`، واحفظ المسارات. (§مسارات الأدوات)
- [ ] انسخ المستودع إلى `~/erp`.
- [ ] أنشئ `apps/api/.env` من `apps/api/.env.example`، بقيم الإنتاج ومسارات مطلقة، و`MYSQLDUMP_PATH`
      و`MYSQL_PATH` من `which`. (§ملف `apps/api/.env`)
- [ ] ولّد الأسرار الثلاثة على جهازك (`JWT_ACCESS_SECRET` و`EINVOICE_ENC_KEY` و`BACKUP_ENCRYPTION_KEY`)،
      وضعها في `.env` وفي مدير كلمات المرور. (§ملف `apps/api/.env`)

## التثبيت والبناء والقاعدة
- [ ] `pnpm install --frozen-lockfile --prod=false` (§النشر الأول 1)
- [ ] `pnpm --filter api prisma:generate` (§النشر الأول 2)
- [ ] `pnpm build` (§النشر الأول 3)
- [ ] `echo $DATABASE_URL` فارغ أو يشير إلى القاعدة الصحيحة: متغير الـ shell يغلب `.env`. (§ملف `apps/api/.env`)
- [ ] `pnpm --filter api exec prisma migrate deploy` (§النشر الأول 4؛ عند الفشل: §القاعدة، «أي migration فاشلة»)
- [ ] `pnpm --filter api exec prisma db seed` (§النشر الأول 4)

## التشغيل
- [ ] `node dist/jobs/cli.js preflight` من `apps/api`: لا `error`. (§النشر الأول 5)
- [ ] شغّل التطبيق من لوحة Node: `node --max-old-space-size=512 dist/main.js`، مجلد العمل `apps/api`،
      **نسخة واحدة**. (§النشر الأول 6)
- [ ] `https://<النطاق>/api/v1/health` يرد 200، ولا تحذير `TrustProxy` في السجل. (§النشر الأول 6)
- [ ] أعد `preflight` بعد التشغيل: لا `error`.

## Cron
- [ ] سطر `PATH` أعلى الملف، أو مسار `node` المطلق في كل سطر. (§النشر الأول 8)
- [ ] `tenant-status` يومياً، و`einvoice-send` كل دقيقة (النجاح إلى `/dev/null`).
- [ ] `backup` يومياً، و`error-digest` كل ساعة، و`stock-verify` يومياً، و`purge-expired` يومياً.
- [ ] `integrity-check` شهرياً، وتدوير `jobs.log` أسبوعياً، و`backup-verify latest` شهرياً (اختياري آلياً).
- [ ] المجموع: pool التطبيق + 2 × 3 تحت `max_user_connections` (سطر `connections` في `preflight`).
- [ ] مراقب خارجي على `/api/v1/health` كل 5 دقائق. (§النشر الأول 9)

## الحساب الأول
- [ ] سجّل حساب المالك من `https://<النطاق>`. (§النشر الأول 7)
- [ ] `node dist/jobs/cli.js grant-platform-admin <البريد>` (§النشر الأول 7)
- [ ] فحص يدوي: الدخول، وميزان مراجعة متوازن لشركة تجريبية، وطباعة فاتورة PDF، وتبويب «الأخطاء».
      (§النشر الأول 10)

## النسخ الاحتياطي
- [ ] `node dist/jobs/cli.js backup` ينجح. (§النشر الأول 11)
- [ ] `node dist/jobs/cli.js backup-verify latest` ينجح، وسُجّل في جدول `backup-restore.md`.
- [ ] `BACKUP_ENCRYPTION_KEY` و`EINVOICE_ENC_KEY` محفوظان خارج الخادم.

## التوثيق
- [ ] نسخة MariaDB الفعلية (سطر `database` في `preflight`) مكتوبة في ADR-019. (§النشر الأول 12)
- [ ] نسخة Node (`node -v`) والـ commit المنشور (`git rev-parse --short HEAD`) مسجّلان مع تاريخ النشر.

خادم Windows على الشبكة المحلية: راجع [دليل Windows LAN](windows-lan.md).
