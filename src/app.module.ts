import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AppConfig } from './config/app-config.service';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { LoggerModule } from './infra/logger/logger.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { OrdersModule } from './orders/orders.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => [
        { ttl: config.throttleTtlMs, limit: config.throttleLimit },
      ],
    }),
    PrismaModule,
    UsersModule,
    AuthModule,
    CatalogModule,
    SubscriptionsModule,
    OrdersModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
