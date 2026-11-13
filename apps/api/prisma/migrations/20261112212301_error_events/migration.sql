-- CreateTable
CREATE TABLE `error_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `fingerprint` CHAR(64) NOT NULL,
    `source` ENUM('API', 'WEB', 'JOB') NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `message` VARCHAR(1000) NOT NULL,
    `stack` TEXT NULL,
    `method` VARCHAR(10) NULL,
    `path` VARCHAR(500) NULL,
    `status` INTEGER NULL,
    `tenant_id` BIGINT UNSIGNED NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `request_id` VARCHAR(64) NULL,
    `count` INTEGER NOT NULL DEFAULT 1,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at` DATETIME(3) NULL,
    `notified_at` DATETIME(3) NULL,

    UNIQUE INDEX `error_events_fingerprint_key`(`fingerprint`),
    INDEX `error_events_resolved_at_last_seen_at_idx`(`resolved_at`, `last_seen_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
