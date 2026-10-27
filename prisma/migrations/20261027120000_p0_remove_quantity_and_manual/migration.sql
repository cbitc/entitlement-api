-- AlterTable
ALTER TABLE `Payment` MODIFY `provider` ENUM('ALIPAY') NOT NULL;

-- AlterTable
ALTER TABLE `PaymentNotification` MODIFY `provider` ENUM('ALIPAY') NOT NULL;

-- AlterTable
ALTER TABLE `PaymentOrder` DROP COLUMN `quantity`;

-- AlterTable
ALTER TABLE `SubscriptionChange` DROP COLUMN `targetQuantity`;

-- AlterTable
ALTER TABLE `SubscriptionPeriod` DROP COLUMN `quantity`;
