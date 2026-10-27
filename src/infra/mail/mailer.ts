export interface LoginCodeMail {
  readonly to: string;
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * A rendered transactional message.
 *
 * The notification module owns rendering; the transport only delivers. Swapping
 * SMTP for a provider API therefore never touches message copy.
 */
export interface OutboundMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * Outbound mail port.
 *
 * The verification module and the notification module depend on this
 * abstraction only, so swapping the transport (log, SMTP, a provider API)
 * never touches the login flow or the message templates.
 */
export abstract class Mailer {
  abstract sendLoginCode(mail: LoginCodeMail): Promise<void>;
  abstract sendMail(mail: OutboundMail): Promise<void>;
}
