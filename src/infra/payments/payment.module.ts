import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { AppConfigModule } from '../../config/config.module';
import { Clock } from '../clock/clock';
import { AlipayGateway } from './alipay.gateway';
import { LogPaymentGateway } from './log-payment.gateway';
import { PaymentGateway } from './payment-gateway';

@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PaymentGateway,
      inject: [AppConfig, Clock],
      useFactory: (config: AppConfig, clock: Clock): PaymentGateway =>
        config.paymentProvider === 'alipay'
          ? new AlipayGateway(config)
          : new LogPaymentGateway(clock),
    },
  ],
  exports: [PaymentGateway],
})
export class PaymentModule {}
