import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hostname } from 'node:os';
import { PrismaService } from '../infra/prisma/prisma.service';

/** `host:pid:uuid`, the owner written by `JobRunnerService`. */
const OWNER_PATTERN = /^(.*):(\d+):([0-9a-fA-F-]{36})$/;

interface LeaseRow {
  readonly owner: string;
  readonly lockedUntil: Date;
}

/**
 * Leases one job name to one process at a time.
 *
 * A lease row is cheaper than a queue and enough for this workload: jobs are
 * idempotent at the domain level, so the only thing that must be prevented is
 * two replicas doing the same sweep at the same moment. The comparison uses
 * the database clock (`NOW(3)`), because a replica with a skewed clock must
 * not be able to steal a live lease.
 *
 * A lease is renewed while its job runs, so the time-to-live only matters
 * after a crash. Locks left by a process on this host that no longer exists
 * are reclaimed immediately, which keeps a dev restart from waiting out the
 * whole lease.
 */
@Injectable()
export class JobLockService {
  private readonly logger = new Logger(JobLockService.name);
  private readonly host = hostname();

  constructor(private readonly prisma: PrismaService) {}

  async acquire(name: string, owner: string, ttlMs: number): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.tryAcquire(name, owner, ttlMs);
      } catch (error) {
        if (!this.isRetryable(error)) {
          throw error;
        }
        if (attempt === 1) {
          // Jobs are periodic and idempotent; losing one tick to contention is
          // safer than turning it into a scheduler error.
          this.logger.debug(
            { job: name, err: error },
            'Job lease contention; retrying on the next tick',
          );
          return false;
        }
        await delay(20 + Math.floor(Math.random() * 40));
      }
    }
    return false;
  }

  private async tryAcquire(
    name: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const seconds = Math.max(1, Math.ceil(ttlMs / 1000));

    // Atomic create-if-absent. Two callers that both see "no row" can no
    // longer both try to INSERT (which made MySQL report a deadlock); one
    // inserts, the other's statement is ignored by the unique key.
    // `INSERT IGNORE` reports 1 for the insert and 0 for the duplicate, which
    // `ON DUPLICATE KEY UPDATE name = name` does not (it reports 1 for both).
    const inserted = await this.prisma.$executeRaw`
      INSERT IGNORE INTO JobLock (name, owner, lockedUntil, updatedAt)
      VALUES (${name}, ${owner}, DATE_ADD(NOW(3), INTERVAL ${seconds} SECOND), NOW(3))
    `;
    if (inserted > 0) {
      return true;
    }

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        LeaseRow[]
      >`SELECT owner, lockedUntil FROM JobLock WHERE name = ${name} FOR UPDATE`;

      const existing = rows[0];
      if (!existing) {
        // The holder released it between the insert and the lock; the next
        // tick will win the insert.
        return false;
      }

      const now = await this.databaseNow(tx);
      if (existing.lockedUntil.getTime() > now.getTime()) {
        if (!this.isDeadLocalOwner(existing.owner)) {
          return false;
        }
        // `nest start --watch` restarts the child without unwinding its
        // timers; waiting out the lease there would silently pause every
        // sweep for a minute.
        this.logger.warn(
          { job: name, previousOwner: existing.owner },
          'Reclaiming a lease left by a dead local process',
        );
      }

      // Guard on the owner we inspected: if it changed while waiting for the
      // row lock, someone else already took the lease.
      const updated = await tx.jobLock.updateMany({
        where: { name, owner: existing.owner },
        data: {
          owner,
          lockedUntil: new Date(now.getTime() + ttlMs),
        },
      });
      return updated.count > 0;
    });
  }

  /**
   * Pushes the expiry forward. A job that outlives the time-to-live keeps its
   * lease as long as this succeeds; losing it means another process may have
   * taken over.
   */
  async extend(name: string, owner: string, ttlMs: number): Promise<boolean> {
    const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
    const affected = await this.prisma.$executeRaw`
      UPDATE JobLock
      SET lockedUntil = DATE_ADD(NOW(3), INTERVAL ${seconds} SECOND)
      WHERE name = ${name} AND owner = ${owner}
    `;
    return affected > 0;
  }

  /** Removes the lease; only the holder can delete it. */
  async release(name: string, owner: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM JobLock WHERE name = ${name} AND owner = ${owner}
    `;
  }

  /** Who holds a job, for an operator-readable skip message. */
  inspect(name: string): Promise<{ owner: string; lockedUntil: Date } | null> {
    return this.prisma.jobLock.findUnique({
      where: { name },
      select: { owner: true, lockedUntil: true },
    });
  }

  private isDeadLocalOwner(owner: string): boolean {
    const match = OWNER_PATTERN.exec(owner);
    if (!match) {
      return false;
    }

    const [, host, pidText] = match;
    if (host !== this.host) {
      return false;
    }

    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      // ESRCH means the process is gone; EPERM means it exists but belongs to
      // another user, which still counts as alive.
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT NOW(3) AS now`;
    return rows[0]?.now ?? new Date();
  }

  private isRetryable(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      // P2034: write conflict/deadlock; P2002: an older path lost the insert
      // race. Both mean "somebody else was acquiring", not a broken job.
      (error.code === 'P2034' || error.code === 'P2002')
    );
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
