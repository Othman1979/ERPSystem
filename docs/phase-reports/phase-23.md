# تقرير المرحلة 23: محرر الصلاحيات المرن (أدوار الشركة)

**المرجع:** [ADR-038](../decisions/ADR-038-phase23-permissions-editor.md) و[BUILD_PLAN.md](../BUILD_PLAN.md) §17.
**التاريخ:** 2026-11-20

## 1. ما تم إنجازه مقابل المخرجات (§17)

- أدوار خاصة بكل شركة: رمز واسم عربي وإنجليزي ووصف، ومجموعة صلاحيات من الكتالوج. `tenant.read` تُضاف دائماً.
- إسناد دور الشركة لعضو (ليس المالك). صلاحياته تحل محل صلاحيات الدور الأساسي، مع بقاء صلاحيات الشراء الفردية (ADR-024).
- الحارس `TenantGuard` و`/me` يقرآن الصلاحيات نفسها، فما تعرضه الواجهة هو ما يُفرض.
- تبويب "الأدوار" في صفحة المستخدمين، ومحرر صلاحيات مجمّع حسب الوحدة، وعمود "دور الشركة" في قائمة الأعضاء. النصوص بالعربية والإنجليزية.

## 2. الجداول والـ migrations

Migration `phase23_custom_roles`: جدولا `tenant_roles` و`tenant_role_permissions` بمفاتيح مركبة `[tenant_id, id]`،
وعمود `tenant_memberships.custom_role_id` (يقبل NULL، FK مركب، `ON DELETE RESTRICT`). لا جداول مالية متأثرة.

## 3. الـ endpoints والشاشات

`GET /roles/catalog`، `GET|POST /roles/custom`، `PUT|DELETE /roles/custom/:id` (`user.manage`).
`PATCH /users/:membershipId` يقبل `customRoleId` (أو `null` لإلغائه). كود خطأ جديد `ROLE_IN_USE` (409).
الشاشات: `apps/web/src/pages/users/RolesTab.tsx` و`UsersPage.tsx`.

## 4. الاختبارات

- `test/e2e/golden-custom-roles.e2e.spec.ts`: G1–G3، ورفض دور الشركة للمالك، وعزل المستأجر B، و403 لغير المالك.
- `test/e2e/isolation-sweep.e2e.spec.ts`: مسارات `/roles/custom/{id}` مضافة.
- `apps/web/src/pages/users/RolesTab.spec.ts`: تجميع الصلاحيات وترجماتها.
- `pnpm typecheck` و`pnpm lint` واختبارات الويب.

## 5. قرارات اتُّخذت

- دور الشركة **يستبدل** صلاحيات الدور الأساسي ولا يُضاف إليها، ليكون التقييد ممكناً (ADR-038 §2).
- إدارة الفريق (`user.manage`) تبقى للمالك فقط ولا تدخل في أي دور شركة (PLAT-28).
- حذف دور مُسند ممنوع؛ يُغيَّر دور الأعضاء أولاً.

## 6. ما لم يُنجز / مؤجل

أدوار لكل فرع، وصلاحيات على مستوى الحقول، ونسخ الأدوار بين الشركات.

## 7. معلّق عند المالك

مراجعة أسماء الصلاحيات في المحرر وتجميعها.
