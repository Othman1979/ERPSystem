-- Data migration (decisions.md §Platform, ADR-012 §User management): user management
-- belongs to the OWNER only. Roles are platform-global, so this one delete covers every
-- existing tenant; prisma/seed.ts no longer grants it either. No schema change.
DELETE rp FROM `role_permissions` rp
  JOIN `roles` r ON r.`id` = rp.`role_id`
 WHERE r.`code` = 'ACCOUNTANT'
   AND rp.`permission_code` = 'user.manage';
