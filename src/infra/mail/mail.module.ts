import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { AppConfigModule } from '../../config/config.module';
import { LogMailer } from './log.mailer';
import { Mailer } from './mailer';
import { SmtpMailer } from './smtp.mailer';

@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: Mailer,
      inject: [AppConfig],
      useFactory: (config: AppConfig): Mailer =>
        config.mailTransport === 'smtp'
          ? new SmtpMailer(config)
          : new LogMailer(),
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
