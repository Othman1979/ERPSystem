UPDATE `document_sequences` AS d
JOIN `fiscal_years` AS f
  ON f.`tenant_id` = d.`tenant_id`
  AND f.`company_id` = d.`company_id`
  AND f.`id` = d.`fiscal_year_id`
SET d.`prefix` = CONCAT('FS-', f.`code`)
WHERE d.`document_type` = 'PAYROLL_SETTLEMENT';
