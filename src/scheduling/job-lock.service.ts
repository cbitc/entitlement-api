import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra/prisma/prisma.service';

/**
 * Leases one job name to one process at a time.
 *
 * A lease row is cheaper than a queue and enough for this workload: jobs are
 * idempotent at the domain level, so the only thing that must be prevented is
 * two replicas doing the same sweep at the same moment. The comparison uses
 * the database clock (`NOW(3)`), because a replica with a skewed clock must
 * not be able to steal a live lease.
 */
@Injectable()
export class JobLockService {
  constructor(private readonly prisma: PrismaService) {}

  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ lockedUntil: Date }>
        >`SELECT lockedUntil FROM JobLock WHERE name = ${name} FOR UPDATE`;

        const now = await this.databaseNow(tx);

        const existing = rows[0];
        if (!existing) {
          // Two processes can both see "no row"; the unique key picks a winner
          // and the loser treats the race as "someone else has it".
          await tx.jobLock.create({
            data: {
              name,
              owner,
              lockedUntil: new Date(now.getTime() + ttlMs),
            },
          });
          return true;
        }

        if (existing.lockedUntil.getTime() > now.getTime()) {
          return false;
        }

        await tx.jobLock.update({
          where: { name },
          data: {
            owner,
            lockedUntil: new Date(now.getTime() + ttlMs),
          },
        });
        return true;
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  /** Expires the lease immediately; only the holder may release it. */
  async release(name: string, owner: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE JobLock SET lockedUntil = NOW(3)
      WHERE name = ${name} AND owner = ${owner}
    `;
  }

  private async databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW(3) AS now`;
    return rows[0]?.now ?? new Date();
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
