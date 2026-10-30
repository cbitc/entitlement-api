import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppConfig } from '../../config/app-config.service';
import { Mailer, type OutboundMail } from './mailer';

/** SMTP transport used outside development. */
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter;

  constructor(private readonly config: AppConfig) {
    super();
    const smtp = config.smtp;

    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    });
  }

  async sendMail(mail: OutboundMail): Promise<void> {
    await this.transport.sendMail({
      from: this.config.smtp.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  }
}
