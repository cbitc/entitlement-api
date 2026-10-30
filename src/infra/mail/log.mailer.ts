import { Logger } from '@nestjs/common';
import { Mailer, type OutboundMail } from './mailer';

/**
 * Development and test transport: prints the message instead of sending it.
 *
 * `env.schema.ts` refuses this transport in production, because customer mail
 * in the log stream is a data leak.
 */
export class LogMailer extends Mailer {
  private readonly logger = new Logger(LogMailer.name);

  async sendMail(mail: OutboundMail): Promise<void> {
    this.logger.log(
      `MAIL_TRANSPORT=log: to=${mail.to} subject="${mail.subject}"\n${mail.text}`,
    );
  }
}
