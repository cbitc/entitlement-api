import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User, UserRole } from '@prisma/client';

/** Claims carried by a session token. `sub` is the user id. */
export interface SessionClaims {
  readonly sub: string;
  readonly email: string;
  readonly role: UserRole;
}

/**
 * Mints session tokens.
 *
 * The subject is the account id, not the email: the address is a claim that
 * can change later, while the id is stable for every table that references it.
 */
@Injectable()
export class SessionTokenService {
  constructor(private readonly jwt: JwtService) {}

  issue(user: User): Promise<string> {
    return this.jwt.signAsync(
      { email: user.email, role: user.role },
      { subject: user.id },
    );
  }
}
