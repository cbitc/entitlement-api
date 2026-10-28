import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  type User,
  type UserRole,
  type UserStatus,
} from '@prisma/client';
import { AppException } from '../common/errors/app.exception';
import {
  pageOf,
  skipFor,
  type Page,
  type Pagination,
} from '../common/http/pagination';
import { Clock } from '../infra/clock/clock';
import { PrismaService } from '../infra/prisma/prisma.service';
import type { UpdateProfileInput } from './users.schemas';

export interface UserListFilter {
  readonly email?: string;
  readonly status?: UserStatus;
  readonly role?: UserRole;
}

/**
 * Owns the account record. It knows nothing about verification codes or
 * sessions: callers prove the email, this service stores who that email is.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

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
    now: Date = this.clock.now(),
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

  /** Admin listing: one page of rows plus the matching count. */
  async listPaged(
    filter: UserListFilter,
    pagination: Pagination,
  ): Promise<Page<User>> {
    const where: Prisma.UserWhereInput = {
      ...(filter.email ? { email: { contains: filter.email } } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.role ? { role: filter.role } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(pagination),
        take: pagination.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return pageOf(items, total, pagination);
  }

  /** Admin detail: the account plus how much history hangs off it. */
  async findDetail(id: string): Promise<{
    readonly user: User;
    readonly subscriptions: number;
    readonly orders: number;
  } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { subscriptions: true, orders: true } } },
    });
    if (!user) {
      return null;
    }

    return {
      user,
      subscriptions: user._count.subscriptions,
      orders: user._count.orders,
    };
  }

  async findByIdOrThrow(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw AppException.notFound('User not found', 'UserNotFound');
    }
    return user;
  }

  /**
   * Disabling takes effect on the next request, because the auth guard re-reads
   * the account. Refusing self-disable keeps the last administrator usable.
   */
  async setStatus(
    actorUserId: string,
    id: string,
    status: UserStatus,
  ): Promise<User> {
    await this.findByIdOrThrow(id);
    if (actorUserId === id && status !== 'ACTIVE') {
      throw AppException.conflict(
        'An administrator cannot disable their own account',
        'CannotDisableSelf',
      );
    }

    return this.prisma.user.update({ where: { id }, data: { status } });
  }

  async setRole(
    actorUserId: string,
    id: string,
    role: UserRole,
  ): Promise<User> {
    await this.findByIdOrThrow(id);
    if (actorUserId === id && role !== 'ADMIN') {
      throw AppException.conflict(
        'An administrator cannot remove their own role',
        'CannotDemoteSelf',
      );
    }

    return this.prisma.user.update({ where: { id }, data: { role } });
  }
}
