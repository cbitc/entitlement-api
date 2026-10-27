import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { AppConfig } from '../config/app-config.service';
import { Mailer } from '../infra/mail/mailer';
import { PrismaService } from '../infra/prisma/prisma.service';
import {
  codesMatch,
  generateVerificationCode,
  hashVerificationCode,
} from './verification-code';
import {
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_RESEND_INTERVAL_MS,
  LOGIN_CODE_TTL_MS,
} from './verification.constants';

export interface IssuedLoginCode {
  readonly email: string;
  readonly expiresAt: Date;
}

/**
 * Issues and redeems one-time login codes.
 *
 * This module knows nothing about accounts: a code proves control of a mailbox
 * before any user row exists. Whoever consumes it decides what it grants.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly config: AppConfig,
  ) {}

  async requestLoginCode(
    email: string,
    now: Date = new Date(),
  ): Promise<IssuedLoginCode> {
    const latest = await this.prisma.verificationCode.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    // Use an elapsed-time comparison, not a wall-clock window. If the host
    // clock is moved backwards (a common way to test expiry), the newest row
    // is suddenly "in the future"; a negative elapsed value must not be read
    // as "sent less than a minute ago", or resends are blocked forever.
    const elapsedMs = latest
      ? now.getTime() - latest.createdAt.getTime()
      : Number.POSITIVE_INFINITY;

    if (latest && elapsedMs >= 0 && elapsedMs < LOGIN_CODE_RESEND_INTERVAL_MS) {
      throw AppException.tooManyRequests(
        'A login code was sent recently, please retry in a minute',
      );
    }

    if (latest && elapsedMs < 0) {
      this.logger.warn(
        {
          email,
          createdAt: latest.createdAt.toISOString(),
          now: now.toISOString(),
        },
        'Verification code timestamp is in the future; allowing a resend',
      );
    }

    const code = generateVerificationCode();
    const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS);
    const codeHash = hashVerificationCode(
      this.config.verificationCodeSecret,
      email,
      code,
    );

    // Invalidate whatever was pending before issuing the new code, so only the
    // most recent message can be redeemed.
    const [, record] = await this.prisma.$transaction([
      this.prisma.verificationCode.updateMany({
        where: { email, consumedAt: null },
        data: { consumedAt: now },
      }),
      this.prisma.verificationCode.create({
        data: {
          email,
          codeHash,
          expiresAt,
          attemptsRemaining: LOGIN_CODE_MAX_ATTEMPTS,
        },
      }),
    ]);

    try {
      await this.mailer.sendLoginCode({ to: email, code, expiresAt });
    } catch (error) {
      this.logger.error(
        { err: error, email },
        'Failed to deliver a login code',
      );
      // Do not leave a code the user never received alive.
      await this.prisma.verificationCode
        .update({ where: { id: record.id }, data: { consumedAt: now } })
        .catch(() => undefined);

      throw new AppException(
        'MailDeliveryFailed',
        HttpStatus.SERVICE_UNAVAILABLE,
        'The login code could not be delivered, please retry later',
      );
    }

    return { email, expiresAt };
  }

  /**
   * Redeems the newest pending code for an address.
   *
   * Throws instead of returning a verdict so a caller cannot accidentally
   * ignore a failure; success means the address is proven right now.
   */
  async consumeLoginCode(
    email: string,
    code: string,
    now: Date = new Date(),
  ): Promise<void> {
    const record = await this.prisma.verificationCode.findFirst({
      where: { email, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw AppException.notFound(
        'No login code is pending for this email',
        'VerificationNotFound',
      );
    }

    if (record.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.verificationCode.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: now },
      });
      throw AppException.gone(
        'The login code has expired, please request a new one',
        'VerificationExpired',
      );
    }

    if (record.attemptsRemaining <= 0) {
      throw new AppException(
        'VerificationAttemptsExceeded',
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many incorrect attempts, please request a new code',
      );
    }

    const actualHash = hashVerificationCode(
      this.config.verificationCodeSecret,
      email,
      code,
    );

    if (!codesMatch(record.codeHash, actualHash)) {
      await this.prisma.verificationCode.update({
        where: { id: record.id },
        data: { attemptsRemaining: { decrement: 1 } },
      });
      throw new AppException(
        'InvalidVerificationCode',
        HttpStatus.UNAUTHORIZED,
        'The login code is incorrect',
      );
    }

    // Compare-and-set: two concurrent requests must not both succeed.
    const claimed = await this.prisma.verificationCode.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: now },
    });

    if (claimed.count === 0) {
      throw AppException.notFound(
        'No login code is pending for this email',
        'VerificationNotFound',
      );
    }
  }
}
