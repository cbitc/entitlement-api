import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { MailModule } from '../infra/mail/mail.module';
import { NotificationsService } from './notifications.service';

/**
 * Owns the outbound mail outbox.
 *
 * It deliberately imports no domain module: senders pass a transaction in and
 * this module only reads the rows it needs, so orders and subscriptions can
 * enqueue without creating a cycle.
 */
@Module({
  imports: [AppConfigModule, MailModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
