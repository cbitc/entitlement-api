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

/** Prisma reports unique-constraint violations with this code. */
const isUniqueViolation = (
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/** The constraint that failed, lowercased (field list or index name). */
const uniqueTarget = (error: Prisma.PrismaClientKnownRequestError): string => {
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.join(',').toLowerCase();
  }
  return String(target ?? '').toLowerCase();
};

export interface UserListFilter {
  readonly email?: string;
  readonly status?: UserStatus;
  readonly role?: UserRole;
}

/** What an identity provider vouches for at the end of a login. */
export interface ExternalIdentityInput {
  /** Stable provider key, e.g. `oidc`. */
  readonly provider: string;
  /** The provider's `sub` claim: the account's identity there. */
  readonly subject: string;
  readonly email: string;
  readonly displayName: string | null;
  /** Linking by address is only safe when the provider verified it. */
  readonly emailVerified: boolean;
}

/**
 * Owns the account record. It knows nothing about OIDC or sessions: the auth
 * module proves which external identity is signing in, this service decides
 * which local account that identity belongs to.
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
   * Resolves a verified identity from the IdP to a local account.
   *
   * Lookup order matters: an existing link wins, so a changed address in the
   * IdP updates the account instead of creating a second one. A brand new
   * subject is linked to an existing account with the same verified address
   * (the migration path for pre-SSO users), and only then is an account
   * created. `role` is never taken from the provider: privileges stay local.
   */
  async upsertFromIdentity(
    input: ExternalIdentityInput,
    now: Date = this.clock.now(),
  ): Promise<User> {
    if (!input.emailVerified) {
      throw new AppException(
        'SsoEmailNotVerified',
        HttpStatus.FORBIDDEN,
        'The identity provider has not verified this email address',
      );
    }

    try {
      return await this.upsertFromIdentityOnce(input, now);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // A concurrent first login inserted the same link or address. Retry
      // once: the second pass finds the row and takes the update path.
      if (uniqueTarget(error).includes('email')) {
        throw AppException.conflict(
          'The email address already belongs to another account',
          'EmailInUseByAnotherAccount',
        );
      }
      return this.upsertFromIdentityOnce(input, now);
    }
  }

  private async upsertFromIdentityOnce(
    input: ExternalIdentityInput,
    now: Date,
  ): Promise<User> {
    const identity = await this.prisma.externalIdentity.findUnique({
      where: {
        provider_subject: {
          provider: input.provider,
          subject: input.subject,
        },
      },
      include: { user: true },
    });

    if (identity) {
      this.assertActive(identity.user.status);

      const emailChanged = identity.user.email !== input.email;
      const [user] = await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: identity.userId },
          data: {
            lastLoginAt: now,
            ...(emailChanged ? { email: input.email } : {}),
            ...(identity.user.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
            ...(identity.user.displayName || !input.displayName
              ? {}
              : { displayName: input.displayName }),
          },
        }),
        this.prisma.externalIdentity.update({
          where: { id: identity.id },
          data: { lastLoginAt: now, email: input.email },
        }),
      ]);
      return user;
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
    });

    if (existing) {
      this.assertActive(existing.status);

      const [user] = await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: existing.id },
          data: {
            lastLoginAt: now,
            emailVerifiedAt: existing.emailVerifiedAt ?? now,
            ...(existing.displayName || !input.displayName
              ? {}
              : { displayName: input.displayName }),
          },
        }),
        this.prisma.externalIdentity.create({
          data: {
            userId: existing.id,
            provider: input.provider,
            subject: input.subject,
            email: input.email,
            lastLoginAt: now,
          },
        }),
      ]);
      return user;
    }

    return this.prisma.user.create({
      data: {
        email: input.email,
        displayName: input.displayName,
        emailVerifiedAt: now,
        lastLoginAt: now,
        externalIdentities: {
          create: {
            provider: input.provider,
            subject: input.subject,
            email: input.email,
            lastLoginAt: now,
          },
        },
      },
    });
  }

  private assertActive(status: UserStatus): void {
    if (status !== 'ACTIVE') {
      throw new AppException(
        'AccountDisabled',
        HttpStatus.FORBIDDEN,
        'This account has been disabled',
      );
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
