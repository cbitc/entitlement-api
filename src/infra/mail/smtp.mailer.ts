import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppConfig } from '../../config/app-config.service';
import { Mailer, type LoginCodeMail, type OutboundMail } from './mailer';

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

    await this.sendMail({
      to: mail.to,
      subject: '登录验证码',
      text: `你的登录验证码是 ${mail.code}，${minutes} 分钟内有效。`,
      html: `<p>你的登录验证码是 <strong>${mail.code}</strong>。</p><p>${minutes} 分钟内有效。</p>`,
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
