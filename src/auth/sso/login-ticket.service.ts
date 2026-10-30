import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config.service';
import { Clock } from '../../infra/clock/clock';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface IssuedLoginTicket {
  readonly ticket: string;
  readonly expiresAt: Date;
}

const hashTicket = (ticket: string): string =>
  createHash('sha256').update(ticket).digest('hex');

/**
 * Exchanges a completed SSO callback for a session token without ever putting
 * the session token in a URL.
 *
 * The ticket is a random 256-bit value; only its hash is stored, so a database
 * read cannot be replayed as a login. Redemption is a compare-and-set, which
 * makes two parallel `/auth/sso/exchange` calls with the same ticket resolve to
 * exactly one session.
 */
@Injectable()
export class LoginTicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async issue(
    userId: string,
    now: Date = this.clock.now(),
  ): Promise<IssuedLoginTicket> {
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      now.getTime() + this.config.sso.ticketTtlSeconds * 1000,
    );

    // Opportunistic cleanup keeps the table bounded without a scheduled job.
    await this.prisma.$transaction([
      this.prisma.loginTicket.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
      this.prisma.loginTicket.create({
        data: { userId, tokenHash: hashTicket(ticket), expiresAt },
      }),
    ]);

    return { ticket, expiresAt };
  }

  /** Returns the account the ticket belongs to, or throws. Single use. */
  async consume(ticket: string, now: Date = this.clock.now()): Promise<string> {
    const record = await this.prisma.loginTicket.findUnique({
      where: { tokenHash: hashTicket(ticket) },
    });

    if (!record || record.consumedAt) {
      throw invalidTicket();
    }
    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new AppException(
        'LoginTicketExpired',
        HttpStatus.GONE,
        'The login ticket has expired, please sign in again',
      );
    }

    const claimed = await this.prisma.loginTicket.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (claimed.count === 0) {
      throw invalidTicket();
    }
    return record.userId;
  }
}

const invalidTicket = (): AppException =>
  new AppException(
    'InvalidLoginTicket',
    HttpStatus.UNAUTHORIZED,
    'The login ticket is invalid or has already been used',
  );
