import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { VerificationService } from '../verification/verification.service';
import { SessionTokenService } from './session-token.service';

export interface RequestLoginResult {
  readonly email: string;
  readonly expiresAt: Date;
}

export interface VerifyLoginResult {
  readonly token: string;
}

/**
 * The only place that knows both halves of a login: a verified mailbox
 * (`verification`) and the account it identifies (`users`).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly verification: VerificationService,
    private readonly users: UsersService,
    private readonly tokens: SessionTokenService,
  ) {}

  async requestLogin(email: string): Promise<RequestLoginResult> {
    const { expiresAt } = await this.verification.requestLoginCode(email);
    return { email, expiresAt };
  }

  async verifyLogin(email: string, code: string): Promise<VerifyLoginResult> {
    // Consume first: a code is single-use even if account creation fails.
    await this.verification.consumeLoginCode(email, code);
    const user = await this.users.registerSuccessfulLogin(email);
    return { token: await this.tokens.issue(user) };
  }
}
