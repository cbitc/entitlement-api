import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppConfig } from '../../config/app-config.service';
import { Mailer, type LoginCodeMail } from './mailer';

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

  async sendLoginCode(mail: LoginCodeMail): Promise<void> {
    const minutes = Math.max(
      1,
      Math.round((mail.expiresAt.getTime() - Date.now()) / 60_000),
    );

    await this.transport.sendMail({
      from: this.config.smtp.from,
      to: mail.to,
      subject: 'Your login code',
      text: `Your login code is ${mail.code}. It expires in ${minutes} minutes.`,
      html: `<p>Your login code is <strong>${mail.code}</strong>.</p><p>It expires in ${minutes} minutes.</p>`,
    });
  }
}
