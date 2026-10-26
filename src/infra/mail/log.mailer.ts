import { Logger } from '@nestjs/common';
import { Mailer, type LoginCodeMail } from './mailer';

/**
 * Development and test transport: prints the code instead of sending mail.
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
}
