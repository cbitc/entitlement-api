export interface LoginCodeMail {
  readonly to: string;
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * Outbound mail port.
 *
 * The verification module depends on this abstraction only, so swapping the
 * transport (log, SMTP, a provider API) never touches the login flow.
 */
export abstract class Mailer {
  abstract sendLoginCode(mail: LoginCodeMail): Promise<void>;
}
