import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module';
import { OrdersModule } from '../orders/orders.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UsersModule } from '../users/users.module';
import { AdminCatalogController } from './admin.catalog.controller';
import { AdminController } from './admin.controller';
import { CatalogAdminService } from './catalog-admin.service';

/**
 * The support console: thin controllers over the domain services.
 *
 * It owns no data of its own. Every write it exposes goes through the service
 * that already guards that invariant (periods, fulfilment, catalogue states),
 * so the admin path cannot drift from the customer path.
 */
@Module({
  imports: [UsersModule, SubscriptionsModule, OrdersModule, LicensingModule],
  controllers: [AdminController, AdminCatalogController],
  providers: [CatalogAdminService],
})
export class AdminModule {}
