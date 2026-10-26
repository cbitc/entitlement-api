-- CreateTable
CREATE TABLE `PaymentOrder` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NULL,
    `kind` ENUM('NEW_SUBSCRIPTION', 'RENEWAL', 'TRIAL_CONVERSION') NOT NULL,
    `status` ENUM('PENDING', 'PAID', 'FULFILLED', 'CLOSED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `planVersionId` VARCHAR(191) NOT NULL,
    `interval` ENUM('MONTH', 'YEAR') NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `unitPriceCents` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `pendingKey` VARCHAR(191) NULL,
    `renewalKey` VARCHAR(191) NULL,
    `sourcePeriodId` VARCHAR(191) NULL,
    `changeId` VARCHAR(191) NULL,
    `appliedPeriodId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `paidAt` DATETIME(3) NULL,
    `fulfilledAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `failureReason` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PaymentOrder_number_key`(`number`),
    UNIQUE INDEX `PaymentOrder_pendingKey_key`(`pendingKey`),
    UNIQUE INDEX `PaymentOrder_renewalKey_key`(`renewalKey`),
    UNIQUE INDEX `PaymentOrder_changeId_key`(`changeId`),
    UNIQUE INDEX `PaymentOrder_appliedPeriodId_key`(`appliedPeriodId`),
    INDEX `PaymentOrder_userId_status_idx`(`userId`, `status`),
    INDEX `PaymentOrder_status_expiresAt_idx`(`status`, `expiresAt`),
    INDEX `PaymentOrder_subscriptionId_status_idx`(`subscriptionId`, `status`),
    INDEX `PaymentOrder_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payment` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `provider` ENUM('ALIPAY', 'MANUAL') NOT NULL,
    `channel` VARCHAR(32) NULL,
    `status` ENUM('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CLOSED') NOT NULL DEFAULT 'INITIATED',
    `amountCents` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `providerTradeNo` VARCHAR(64) NULL,
    `successKey` VARCHAR(191) NULL,
    `buyerId` VARCHAR(64) NULL,
    `failureCode` VARCHAR(64) NULL,
    `failureMessage` VARCHAR(255) NULL,
    `initiatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `paidAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Payment_successKey_key`(`successKey`),
    INDEX `Payment_orderId_status_idx`(`orderId`, `status`),
    UNIQUE INDEX `Payment_provider_providerTradeNo_key`(`provider`, `providerTradeNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentNotification` (
    `id` VARCHAR(191) NOT NULL,
    `provider` ENUM('ALIPAY', 'MANUAL') NOT NULL,
    `externalId` VARCHAR(128) NOT NULL,
    `verified` BOOLEAN NOT NULL DEFAULT false,
    `eventType` VARCHAR(64) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NULL,
    `status` ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED') NOT NULL DEFAULT 'RECEIVED',
    `payload` JSON NOT NULL,
    `errorMessage` VARCHAR(255) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PaymentNotification_status_receivedAt_idx`(`status`, `receivedAt`),
    UNIQUE INDEX `PaymentNotification_provider_externalId_key`(`provider`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Refund` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `providerRefundNo` VARCHAR(64) NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `failureReason` VARCHAR(120) NULL,

    UNIQUE INDEX `Refund_providerRefundNo_key`(`providerRefundNo`),
    INDEX `Refund_orderId_status_idx`(`orderId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PaymentOrder` ADD CONSTRAINT `PaymentOrder_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentOrder` ADD CONSTRAINT `PaymentOrder_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentOrder` ADD CONSTRAINT `PaymentOrder_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentOrder` ADD CONSTRAINT `PaymentOrder_planVersionId_fkey` FOREIGN KEY (`planVersionId`) REFERENCES `PlanVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentOrder` ADD CONSTRAINT `PaymentOrder_sourcePeriodId_fkey` FOREIGN KEY (`sourcePeriodId`) REFERENCES `SubscriptionPeriod`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentOrder` ADD CONSTRAINT `PaymentOrder_changeId_fkey` FOREIGN KEY (`changeId`) REFERENCES `SubscriptionChange`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentOrder` ADD CONSTRAINT `PaymentOrder_appliedPeriodId_fkey` FOREIGN KEY (`appliedPeriodId`) REFERENCES `SubscriptionPeriod`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `PaymentOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentNotification` ADD CONSTRAINT `PaymentNotification_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `PaymentOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentNotification` ADD CONSTRAINT `PaymentNotification_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `PaymentOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Refund` ADD CONSTRAINT `Refund_requestedByUserId_fkey` FOREIGN KEY (`requestedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
