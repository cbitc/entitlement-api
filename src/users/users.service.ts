import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import type { UpdateProfileInput } from './users.schemas';

/**
 * Owns the account record. It knows nothing about verification codes or
 * sessions: callers prove the email, this service stores who that email is.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /** Resolves the caller of an authenticated request. */
  findActiveById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, status: 'ACTIVE' } });
  }

  /**
   * Records a successful email verification: creates the account on first
   * login, otherwise only moves `lastLoginAt`. A disabled account is refused.
   */
  async registerSuccessfulLogin(
    email: string,
    now: Date = new Date(),
  ): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      if (existing.status !== 'ACTIVE') {
        throw new AppException(
          'AccountDisabled',
          HttpStatus.FORBIDDEN,
          'This account has been disabled',
        );
      }
      return this.prisma.user.update({
        where: { id: existing.id },
        data: { lastLoginAt: now },
      });
    }

    try {
      return await this.prisma.user.create({
        data: { email, emailVerifiedAt: now, lastLoginAt: now },
      });
    } catch (error) {
      // Two first-time logins racing: the loser just records the same login.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.prisma.user.update({
          where: { email },
          data: { lastLoginAt: now },
        });
      }
      throw error;
    }
  }

  updateProfile(id: string, input: UpdateProfileInput): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { displayName: input.displayName },
    });
  }
}
