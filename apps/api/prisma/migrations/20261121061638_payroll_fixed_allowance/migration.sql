-- AlterTable
ALTER TABLE `pay_elements` ADD COLUMN `is_fixed_allowance` BOOLEAN NOT NULL DEFAULT false;

UPDATE `pay_elements` AS element
LEFT JOIN `employee_recurring_elements` AS recurring
  ON recurring.`tenant_id` = element.`tenant_id`
  AND recurring.`pay_element_id` = element.`id`
SET element.`is_fixed_allowance` = 1
WHERE element.`kind` = 'EARNING'
  AND element.`amount_type` = 'FIXED'
  AND element.`code` <> 'BONUS'
  AND (
    element.`code` IN ('TRANSPORT', 'HOUSING')
    OR recurring.`id` IS NOT NULL
  );
