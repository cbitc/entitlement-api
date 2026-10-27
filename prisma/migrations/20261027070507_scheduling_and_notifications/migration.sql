-- CreateTable
CREATE TABLE `JobLock` (
    `name` VARCHAR(64) NOT NULL,
    `owner` VARCHAR(128) NOT NULL,
    `lockedUntil` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobRun` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `status` ENUM('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'RUNNING',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `result` JSON NULL,
    `errorMessage` VARCHAR(255) NULL,
    `instanceId` VARCHAR(128) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JobRun_name_startedAt_idx`(`name`, `startedAt`),
    INDEX `JobRun_status_startedAt_idx`(`status`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboundNotification` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `email` VARCHAR(254) NOT NULL,
    `type` ENUM('PAYMENT_SUCCEEDED', 'SUBSCRIPTION_EXPIRED', 'REFUND_ISSUED') NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `subject` VARCHAR(200) NOT NULL,
    `payload` JSON NOT NULL,
    `dedupeKey` VARCHAR(191) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `claimedAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `lastError` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OutboundNotification_dedupeKey_key`(`dedupeKey`),
    INDEX `OutboundNotification_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `OutboundNotification_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OutboundNotification` ADD CONSTRAINT `OutboundNotification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
