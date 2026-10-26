import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { AppConfigModule } from '../../config/config.module';
import { AlipayGateway } from './alipay.gateway';
import { LogPaymentGateway } from './log-payment.gateway';
import { PaymentGateway } from './payment-gateway';

@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PaymentGateway,
      inject: [AppConfig],
      useFactory: (config: AppConfig): PaymentGateway =>
        config.paymentProvider === 'alipay'
          ? new AlipayGateway(config)
          : new LogPaymentGateway(),
    },
  ],
  exports: [PaymentGateway],
})
export class PaymentModule {}
