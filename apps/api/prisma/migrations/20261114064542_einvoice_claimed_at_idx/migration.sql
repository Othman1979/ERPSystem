-- CreateIndex
CREATE INDEX `einvoice_submissions_status_claimed_at_idx` ON `einvoice_submissions`(`status`, `claimed_at`);
