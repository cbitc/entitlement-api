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
 * The notification module depends on this abstraction only, so swapping the
 * transport (log, SMTP, a provider API) never touches the message templates.
 */
export abstract class Mailer {
  abstract sendMail(mail: OutboundMail): Promise<void>;
}
