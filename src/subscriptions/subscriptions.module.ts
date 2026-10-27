import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { SubscriptionPeriodsService } from './subscription-periods.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [NotificationsModule],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    SubscriptionPeriodsService,
    SubscriptionLifecycleService,
  ],
  exports: [
    SubscriptionsService,
    SubscriptionPeriodsService,
    SubscriptionLifecycleService,
  ],
})
export class SubscriptionsModule {}
