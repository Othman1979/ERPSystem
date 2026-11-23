INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`,
   `next_number`, `padding`, `created_at`, `updated_at`)
SELECT fy.`tenant_id`, fy.`company_id`, t.`doc_type`, fy.`id`,
       CONCAT(t.`prefix`, '-', fy.`code`), 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` fy
JOIN (
  SELECT 'CONSIGNMENT_IN' AS `doc_type`, 'CIN' AS `prefix`
  UNION ALL SELECT 'CONSIGNMENT_OUT', 'COUT'
) t
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` ds
  WHERE ds.`tenant_id` = fy.`tenant_id` AND ds.`company_id` = fy.`company_id`
    AND ds.`document_type` = t.`doc_type` AND ds.`fiscal_year_id` = fy.`id`
);
