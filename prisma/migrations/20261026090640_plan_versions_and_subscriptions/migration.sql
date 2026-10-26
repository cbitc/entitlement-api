/*
  Versioned catalogue.

  Every existing plan becomes version 1 of itself. A plan that was active is
  PUBLISHED (and therefore still sellable); an inactive one becomes DRAFT so it
  keeps its content without being offered. Prices and feature values move onto
  that version, which is what makes later commercial edits a new row instead of
  an update that would silently change what existing subscribers own.
*/

-- AlterTable
ALTER TABLE `Feature` ADD COLUMN `consumable` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `PlanVersion` (
    `id` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'CLOSED_FOR_SALE', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
    `publishedKey` VARCHAR(191) NULL,
    `maxActivations` INTEGER NOT NULL DEFAULT 1,
    `trialDays` INTEGER NOT NULL DEFAULT 0,
    `trialMaxActivations` INTEGER NOT NULL DEFAULT 1,
    `publishedAt` DATETIME(3) NULL,
    `saleClosedAt` DATETIME(3) NULL,
    `retiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PlanVersion_publishedKey_key`(`publishedKey`),
    INDEX `PlanVersion_status_idx`(`status`),
    UNIQUE INDEX `PlanVersion_planId_version_key`(`planId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlanVersionPrice` (
    `id` VARCHAR(191) NOT NULL,
    `planVersionId` VARCHAR(191) NOT NULL,
    `interval` ENUM('MONTH', 'YEAR') NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'cny',
    `priceCents` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PlanVersionPrice_planVersionId_interval_currency_key`(`planVersionId`, `interval`, `currency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlanVersionFeature` (
    `id` VARCHAR(191) NOT NULL,
    `planVersionId` VARCHAR(191) NOT NULL,
    `featureId` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PlanVersionFeature_featureId_idx`(`featureId`),
    UNIQUE INDEX `PlanVersionFeature_planVersionId_featureId_key`(`planVersionId`, `featureId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Backfill: one PUBLISHED (or DRAFT for a retired listing) version per plan.
INSERT INTO `PlanVersion` (`id`, `planId`, `version`, `status`, `publishedKey`, `maxActivations`, `trialDays`, `trialMaxActivations`, `publishedAt`, `createdAt`, `updatedAt`)
SELECT UUID(), `id`, 1, IF(`active`, 'PUBLISHED', 'DRAFT'), IF(`active`, `id`, NULL), `maxActivations`, `trialDays`, `trialMaxActivations`, IF(`active`, NOW(3), NULL), NOW(3), NOW(3)
FROM `Plan`;

INSERT INTO `PlanVersionPrice` (`id`, `planVersionId`, `interval`, `currency`, `priceCents`, `createdAt`, `updatedAt`)
SELECT UUID(), `version`.`id`, `price`.`interval`, `price`.`currency`, `price`.`priceCents`, `price`.`createdAt`, `price`.`updatedAt`
FROM `PlanPrice` `price`
JOIN `PlanVersion` `version` ON `version`.`planId` = `price`.`planId` AND `version`.`version` = 1;

INSERT INTO `PlanVersionFeature` (`id`, `planVersionId`, `featureId`, `value`, `createdAt`, `updatedAt`)
SELECT UUID(), `version`.`id`, `feature`.`featureId`, `feature`.`value`, `feature`.`createdAt`, `feature`.`updatedAt`
FROM `PlanFeature` `feature`
JOIN `PlanVersion` `version` ON `version`.`planId` = `feature`.`planId` AND `version`.`version` = 1;

-- The old rows are now represented by version 1, so the mutable shelves go.
ALTER TABLE `Plan` DROP FOREIGN KEY `Plan_productId_fkey`;

ALTER TABLE `PlanFeature` DROP FOREIGN KEY `PlanFeature_featureId_fkey`;

ALTER TABLE `PlanFeature` DROP FOREIGN KEY `PlanFeature_planId_fkey`;

ALTER TABLE `PlanPrice` DROP FOREIGN KEY `PlanPrice_planId_fkey`;

DROP INDEX `Plan_productId_active_sortOrder_idx` ON `Plan`;

ALTER TABLE `Plan` DROP COLUMN `active`,
    DROP COLUMN `maxActivations`,
    DROP COLUMN `trialDays`,
    DROP COLUMN `trialMaxActivations`;

DROP TABLE `PlanFeature`;

DROP TABLE `PlanPrice`;

-- CreateTable
CREATE TABLE `Subscription` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `status` ENUM('TRIALING', 'ACTIVE', 'PAUSED', 'CANCELED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `openKey` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Subscription_openKey_key`(`openKey`),
    INDEX `Subscription_userId_status_idx`(`userId`, `status`),
    INDEX `Subscription_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SubscriptionPeriod` (
    `id` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `planVersionId` VARCHAR(191) NOT NULL,
    `kind` ENUM('TRIAL', 'PAID') NOT NULL,
    `status` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `currentKey` VARCHAR(191) NULL,
    `interval` ENUM('MONTH', 'YEAR') NULL,
    `quantity` INTEGER NULL,
    `unitPriceCents` INTEGER NULL,
    `currency` CHAR(3) NULL,
    `maxActivations` INTEGER NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `closeReason` ENUM('RENEWED', 'CHANGED', 'CANCELED', 'PAUSED', 'EXPIRED') NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SubscriptionPeriod_currentKey_key`(`currentKey`),
    INDEX `SubscriptionPeriod_subscriptionId_status_idx`(`subscriptionId`, `status`),
    INDEX `SubscriptionPeriod_planVersionId_idx`(`planVersionId`),
    UNIQUE INDEX `SubscriptionPeriod_subscriptionId_sequence_key`(`subscriptionId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SubscriptionChange` (
    `id` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NOT NULL,
    `kind` ENUM('CHANGE', 'CANCEL', 'PAUSE', 'RESUME') NOT NULL,
    `status` ENUM('PENDING', 'APPLIED', 'CANCELED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `targetPlanVersionId` VARCHAR(191) NULL,
    `targetInterval` ENUM('MONTH', 'YEAR') NULL,
    `targetQuantity` INTEGER NULL,
    `effectiveAt` DATETIME(3) NOT NULL,
    `pendingKey` VARCHAR(191) NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `appliedAt` DATETIME(3) NULL,
    `appliedPeriodId` VARCHAR(191) NULL,
    `failureReason` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SubscriptionChange_pendingKey_key`(`pendingKey`),
    INDEX `SubscriptionChange_subscriptionId_status_idx`(`subscriptionId`, `status`),
    INDEX `SubscriptionChange_status_effectiveAt_idx`(`status`, `effectiveAt`),
    INDEX `SubscriptionChange_targetPlanVersionId_idx`(`targetPlanVersionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrialRedemption` (
    `userId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NULL,
    `firstRedeemedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TrialRedemption_productId_idx`(`productId`),
    PRIMARY KEY (`userId`, `productId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EntitlementGrant` (
    `id` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NOT NULL,
    `subscriptionPeriodId` VARCHAR(191) NOT NULL,
    `planVersionId` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'EXPIRED', 'SUPERSEDED', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `activeKey` VARCHAR(191) NULL,
    `effectiveAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `closedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EntitlementGrant_subscriptionPeriodId_key`(`subscriptionPeriodId`),
    UNIQUE INDEX `EntitlementGrant_activeKey_key`(`activeKey`),
    INDEX `EntitlementGrant_subscriptionId_status_idx`(`subscriptionId`, `status`),
    INDEX `EntitlementGrant_planVersionId_idx`(`planVersionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EntitlementGrantItem` (
    `id` VARCHAR(191) NOT NULL,
    `grantId` VARCHAR(191) NOT NULL,
    `featureId` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,
    `valueType` ENUM('BOOLEAN', 'NUMBER', 'TEXT') NOT NULL,
    `consumable` BOOLEAN NOT NULL DEFAULT false,
    `limit` INTEGER NULL,
    `used` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `EntitlementGrantItem_featureId_idx`(`featureId`),
    UNIQUE INDEX `EntitlementGrantItem_grantId_featureId_key`(`grantId`, `featureId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EntitlementUsage` (
    `id` VARCHAR(191) NOT NULL,
    `grantItemId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(128) NOT NULL,
    `amount` INTEGER NOT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EntitlementUsage_grantItemId_createdAt_idx`(`grantItemId`, `createdAt`),
    UNIQUE INDEX `EntitlementUsage_grantItemId_requestId_key`(`grantItemId`, `requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Plan_productId_sortOrder_idx` ON `Plan`(`productId`, `sortOrder`);

-- AddForeignKey
ALTER TABLE `Plan` ADD CONSTRAINT `Plan_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlanVersion` ADD CONSTRAINT `PlanVersion_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `Plan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlanVersionPrice` ADD CONSTRAINT `PlanVersionPrice_planVersionId_fkey` FOREIGN KEY (`planVersionId`) REFERENCES `PlanVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlanVersionFeature` ADD CONSTRAINT `PlanVersionFeature_planVersionId_fkey` FOREIGN KEY (`planVersionId`) REFERENCES `PlanVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlanVersionFeature` ADD CONSTRAINT `PlanVersionFeature_featureId_fkey` FOREIGN KEY (`featureId`) REFERENCES `Feature`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SubscriptionPeriod` ADD CONSTRAINT `SubscriptionPeriod_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SubscriptionPeriod` ADD CONSTRAINT `SubscriptionPeriod_planVersionId_fkey` FOREIGN KEY (`planVersionId`) REFERENCES `PlanVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SubscriptionChange` ADD CONSTRAINT `SubscriptionChange_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SubscriptionChange` ADD CONSTRAINT `SubscriptionChange_targetPlanVersionId_fkey` FOREIGN KEY (`targetPlanVersionId`) REFERENCES `PlanVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SubscriptionChange` ADD CONSTRAINT `SubscriptionChange_requestedByUserId_fkey` FOREIGN KEY (`requestedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SubscriptionChange` ADD CONSTRAINT `SubscriptionChange_appliedPeriodId_fkey` FOREIGN KEY (`appliedPeriodId`) REFERENCES `SubscriptionPeriod`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrialRedemption` ADD CONSTRAINT `TrialRedemption_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrialRedemption` ADD CONSTRAINT `TrialRedemption_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrialRedemption` ADD CONSTRAINT `TrialRedemption_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EntitlementGrant` ADD CONSTRAINT `EntitlementGrant_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EntitlementGrant` ADD CONSTRAINT `EntitlementGrant_subscriptionPeriodId_fkey` FOREIGN KEY (`subscriptionPeriodId`) REFERENCES `SubscriptionPeriod`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EntitlementGrant` ADD CONSTRAINT `EntitlementGrant_planVersionId_fkey` FOREIGN KEY (`planVersionId`) REFERENCES `PlanVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EntitlementGrantItem` ADD CONSTRAINT `EntitlementGrantItem_grantId_fkey` FOREIGN KEY (`grantId`) REFERENCES `EntitlementGrant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EntitlementGrantItem` ADD CONSTRAINT `EntitlementGrantItem_featureId_fkey` FOREIGN KEY (`featureId`) REFERENCES `Feature`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EntitlementUsage` ADD CONSTRAINT `EntitlementUsage_grantItemId_fkey` FOREIGN KEY (`grantItemId`) REFERENCES `EntitlementGrantItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
