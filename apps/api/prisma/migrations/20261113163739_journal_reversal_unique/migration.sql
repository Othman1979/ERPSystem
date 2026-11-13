-- D-1 / LEDGER-02: an entry is reversed at most once. NULL reversal_of_id
-- (not a reversal) repeats freely. Run `pnpm --filter api ledger:check` first:
-- this fails if an entry already has two reversals (the LEDGER-02 race).
-- CreateIndex
CREATE UNIQUE INDEX `journal_entries_tenant_id_reversal_of_id_key` ON `journal_entries`(`tenant_id`, `reversal_of_id`);

-- LEDGER-14: English names for template accounts that still carry the
-- template's Arabic name and have no English name. Accounts a tenant renamed
-- or named in English are left alone.
UPDATE `accounts` SET `name_en` = 'Assets' WHERE `code` = '1' AND `name_ar` = 'الأصول' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Liabilities' WHERE `code` = '2' AND `name_ar` = 'الخصوم' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Equity' WHERE `code` = '3' AND `name_ar` = 'حقوق الملكية' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Revenue' WHERE `code` = '4' AND `name_ar` = 'الإيرادات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Expenses' WHERE `code` = '5' AND `name_ar` = 'المصروفات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Current assets' WHERE `code` = '11' AND `name_ar` = 'الأصول المتداولة' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Fixed assets' WHERE `code` = '12' AND `name_ar` = 'الأصول الثابتة' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Current liabilities' WHERE `code` = '21' AND `name_ar` = 'الخصوم المتداولة' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Equity' WHERE `code` = '31' AND `name_ar` = 'حقوق الملكية' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Other revenue' WHERE `code` = '42' AND `name_ar` = 'إيرادات أخرى' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Other expenses' WHERE `code` = '52' AND `name_ar` = 'مصروفات أخرى' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Cash' WHERE `code` = '1101' AND `name_ar` = 'الصندوق' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Banks' WHERE `code` = '1102' AND `name_ar` = 'البنوك' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Customers' WHERE `code` = '1103' AND `name_ar` = 'العملاء' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Inventory' WHERE `code` = '1104' AND `name_ar` = 'المخزون' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Input tax' WHERE `code` = '1105' AND `name_ar` = 'ضريبة المشتريات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Furniture and equipment' WHERE `code` = '1201' AND `name_ar` = 'الأثاث والمعدات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Accumulated depreciation' WHERE `code` = '1202' AND `name_ar` = 'مجمع الاستهلاك' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Suppliers' WHERE `code` = '2101' AND `name_ar` = 'الموردون' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Output tax' WHERE `code` = '2102' AND `name_ar` = 'ضريبة المبيعات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Accrued expenses' WHERE `code` = '2103' AND `name_ar` = 'مصاريف مستحقة' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Goods received not invoiced' WHERE `code` = '2104' AND `name_ar` = 'بضاعة مستلمة غير مفوترة' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Capital' WHERE `code` = '3101' AND `name_ar` = 'رأس المال' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Retained earnings' WHERE `code` = '3102' AND `name_ar` = 'الأرباح المدورة' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Opening balances' WHERE `code` = '3103' AND `name_ar` = 'أرصدة افتتاحية' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Sales' WHERE `code` = '4101' AND `name_ar` = 'المبيعات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Sales returns' WHERE `code` = '4102' AND `name_ar` = 'مردودات المبيعات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Sales discounts' WHERE `code` = '4103' AND `name_ar` = 'خصم المبيعات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Other revenue' WHERE `code` = '4201' AND `name_ar` = 'إيرادات أخرى' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Cost of goods sold' WHERE `code` = '5101' AND `name_ar` = 'تكلفة البضاعة المباعة' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Stock count differences and adjustments' WHERE `code` = '5102' AND `name_ar` = 'فروقات الجرد والتسويات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Purchases' WHERE `code` = '5103' AND `name_ar` = 'مشتريات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Salaries' WHERE `code` = '5201' AND `name_ar` = 'الرواتب' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Rent' WHERE `code` = '5202' AND `name_ar` = 'الإيجار' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Electricity, water and telecom' WHERE `code` = '5203' AND `name_ar` = 'الكهرباء والمياه والاتصالات' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'General and administrative expenses' WHERE `code` = '5204' AND `name_ar` = 'مصاريف عمومية وإدارية' AND `name_en` IS NULL;
UPDATE `accounts` SET `name_en` = 'Rounding differences' WHERE `code` = '5205' AND `name_ar` = 'فروقات التقريب' AND `name_en` IS NULL;
