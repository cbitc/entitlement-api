import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { PaymentModule } from '../infra/payments/payment.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { OrderFulfillmentService } from './order-fulfillment.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [AppConfigModule, PaymentModule, SubscriptionsModule],
  controllers: [OrdersController, PaymentsController],
  providers: [OrdersService, OrderFulfillmentService],
  exports: [OrdersService],
})
export class OrdersModule {}
