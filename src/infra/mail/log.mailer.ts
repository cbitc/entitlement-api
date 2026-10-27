import { Logger } from '@nestjs/common';
import { Mailer, type LoginCodeMail, type OutboundMail } from './mailer';

/**
 * Development and test transport: prints the message instead of sending it.
 *
 * `env.schema.ts` refuses this transport in production, because a login code
 * in the log stream is a credential leak.
 */
export class LogMailer extends Mailer {
  private readonly logger = new Logger(LogMailer.name);

  async sendLoginCode(mail: LoginCodeMail): Promise<void> {
    this.logger.warn(
      `MAIL_TRANSPORT=log: login code for ${mail.to} is ${mail.code} (expires ${mail.expiresAt.toISOString()})`,
    );
  }

  async sendMail(mail: OutboundMail): Promise<void> {
    this.logger.log(
      `MAIL_TRANSPORT=log: to=${mail.to} subject="${mail.subject}"\n${mail.text}`,
    );
  }
}
