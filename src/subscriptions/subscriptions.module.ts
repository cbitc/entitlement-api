import { Module } from '@nestjs/common';
import { SubscriptionPeriodsService } from './subscription-periods.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SubscriptionPeriodsService],
  exports: [SubscriptionsService, SubscriptionPeriodsService],
})
export class SubscriptionsModule {}
