import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { AppConfig } from '../config/app-config.service';
import { Clock } from '../infra/clock/clock';
import { PrismaService } from '../infra/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { JobLockService } from './job-lock.service';
import type { JobName, JobOutcome, JobRunView, JobSource } from './job.types';

/**
 * The single entry point for running a job.
 *
 * Both the interval scheduler and the admin trigger go through here, so a
 * manual run is leased, recorded and bounded exactly like a scheduled one.
 * Recording is deliberately best-effort: observability must never turn a
 * successful sweep into a failed request.
 */
@Injectable()
export class JobRunnerService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  private readonly instanceId = `${hostname()}:${process.pid}`.slice(0, 128);
  /** Leases held by this process, so a graceful stop releases them at once. */
  private readonly active = new Map<
    string,
    { readonly owner: string; readonly heartbeat: NodeJS.Timeout }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly lock: JobLockService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly pino: PinoLogger,
    private readonly clock: Clock,
  ) {}

  async run(
    name: JobName,
    options: { readonly limit: number; readonly source: JobSource },
  ): Promise<JobOutcome> {
    // Bind the job to every log line produced while it runs, including the
    // domain services it calls. `inherit` keeps the request context when an
    // operator triggered the run from the console.
    return this.pino.runInContext(() => this.runWithContext(name, options), {
      bindings: { job: name, source: options.source },
      inherit: true,
    });
  }

  private async runWithContext(
    name: JobName,
    options: { readonly limit: number; readonly source: JobSource },
  ): Promise<JobOutcome> {
    const owner = `${this.instanceId}:${randomUUID()}`.slice(0, 128);
    const acquired = await this.lock.acquire(
      name,
      owner,
      this.config.jobs.lockTtlMs,
    );

    if (!acquired) {
      // A scheduled tick that lost the lease is noise; a manual click is not.
      const holder = await this.lock.inspect(name).catch(() => null);
      this.logger.debug(
        {
          skipped: true,
          holder: holder?.owner ?? null,
          lockedUntil: holder?.lockedUntil.toISOString() ?? null,
        },
        'Skipping tick: job lease is held by another instance',
      );
      if (options.source === 'admin') {
        const record = await this.prisma.jobRun.create({
          data: {
            name,
            status: 'SKIPPED',
            instanceId: this.instanceId,
            finishedAt: this.clock.now(),
            durationMs: 0,
            result: { skipped: true },
          },
        });
        return {
          runId: record.id,
          status: 'SKIPPED',
          result: { skipped: true },
        };
      }
      return { runId: null, status: 'SKIPPED' };
    }

    const startedAt = this.clock.now();
    let recordId: string | null = null;

    // A job may legitimately outlive the lease; keep pushing it forward so a
    // slow batch is not stolen by the next tick (or another replica).
    const heartbeat = setInterval(
      () => {
        void this.renewLease(name, owner);
      },
      Math.max(5_000, Math.floor(this.config.jobs.lockTtlMs / 3)),
    );
    heartbeat.unref();
    this.active.set(name, { owner, heartbeat });

    try {
      const record = await this.prisma.jobRun.create({
        data: {
          name,
          status: 'RUNNING',
          instanceId: this.instanceId,
          startedAt,
        },
      });
      recordId = record.id;
      this.pino.assign({ runId: record.id });

      const result = await this.execute(name, options.limit, startedAt);
      const kept = await this.finishRun(
        name,
        record.id,
        startedAt,
        result,
        options.source,
      );
      return {
        runId: kept ? record.id : null,
        status: 'SUCCEEDED',
        result,
      };
    } catch (error) {
      // A failure before the row exists still has to release the lease; a
      // failure after it exists should leave a trace an operator can read.
      if (recordId) {
        await this.recordFailure(recordId, startedAt, error);
      }
      throw error;
    } finally {
      const lease = this.active.get(name);
      if (lease?.owner === owner) {
        this.active.delete(name);
        clearInterval(lease.heartbeat);
      }
      await this.lock.release(name, owner).catch((releaseError: unknown) => {
        this.logger.warn(
          { err: releaseError, job: name },
          'Could not release job lease',
        );
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const held = [...this.active.entries()];
    this.active.clear();

    // `SIGTERM` must not leave a lease that blocks the next process until it
    // expires; a hard kill is handled by the lease time-to-live.
    await Promise.all(
      held.map(async ([name, lease]) => {
        clearInterval(lease.heartbeat);
        try {
          await this.lock.release(name, lease.owner);
        } catch (error) {
          this.logger.warn(
            { err: error, job: name },
            'Could not release job lease on shutdown',
          );
        }
      }),
    );
  }

  private async renewLease(name: string, owner: string): Promise<void> {
    try {
      const renewed = await this.lock.extend(
        name,
        owner,
        this.config.jobs.lockTtlMs,
      );
      if (renewed) {
        return;
      }

      const lease = this.active.get(name);
      if (lease?.owner === owner) {
        clearInterval(lease.heartbeat);
        this.active.delete(name);
      }
      this.logger.error(
        { job: name },
        'Job lease was lost while running; another instance may take over',
      );
    } catch (error) {
      this.logger.warn({ err: error, job: name }, 'Could not renew job lease');
    }
  }

  private execute(name: JobName, limit: number, now: Date): Promise<unknown> {
    switch (name) {
      case 'renewal-orders':
        return this.orders.createRenewalOrders(now, limit);
      case 'settle':
        return this.orders.settleDueSubscriptions(now, limit);
      case 'expire-orders':
        return this.orders.expireOrders(now, limit);
      case 'sync-payments':
        return this.orders.syncPendingOrders(now, limit);
      case 'notifications':
        return this.notifications.dispatch(now, limit);
    }
  }

  /** Recent runs, newest first, for the operations console. */
  async listRuns(filter: {
    readonly name?: JobName;
    readonly limit: number;
  }): Promise<JobRunView[]> {
    const rows = await this.prisma.jobRun.findMany({
      where: filter.name ? { name: filter.name } : {},
      orderBy: { startedAt: 'desc' },
      take: filter.limit,
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
      result: row.result,
      errorMessage: row.errorMessage,
      instanceId: row.instanceId,
    }));
  }

  private async finishRun(
    name: JobName,
    id: string,
    startedAt: Date,
    result: unknown,
    source: JobSource,
  ): Promise<boolean> {
    // The dispatcher ticks every 30s; a row for every empty scheduled tick
    // would bury the runs that actually changed something. A manual run is an
    // explicit operator action and always leaves a trace.
    if (source === 'scheduler' && !this.hasWork(name, result)) {
      await this.prisma.jobRun
        .delete({ where: { id } })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, runId: id },
            'Could not drop the history row of an empty job run',
          );
        });
      this.logger.debug({ job: name, result }, 'Job run had no work');
      return false;
    }

    await this.recordSuccess(id, startedAt, result);
    return true;
  }

  /**
   * Whether a run changed anything. Informational counters (a payment still
   * pending, a renewal already ordered) do not make a run worth keeping.
   */
  private hasWork(name: JobName, result: unknown): boolean {
    if (!result || typeof result !== 'object') {
      return true;
    }

    const counters = result as Record<string, unknown>;
    const count = (key: string): number =>
      typeof counters[key] === 'number' ? (counters[key] as number) : 0;

    switch (name) {
      case 'renewal-orders':
        return count('created') > 0;
      case 'settle':
        return (
          count('fulfilled') +
            count('canceled') +
            count('expired') +
            count('failed') >
          0
        );
      case 'expire-orders':
        return count('closed') > 0;
      case 'sync-payments':
        return count('synced') + count('failed') > 0;
      case 'notifications':
        return count('sent') + count('retried') + count('failed') > 0;
      default:
        return true;
    }
  }

  private async recordSuccess(
    id: string,
    startedAt: Date,
    result: unknown,
  ): Promise<void> {
    const finishedAt = this.clock.now();
    await this.prisma.jobRun
      .update({
        where: { id },
        data: {
          status: 'SUCCEEDED',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          result: result as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error, runId: id }, 'Could not finish job run');
      });
  }

  private async recordFailure(
    id: string,
    startedAt: Date,
    error: unknown,
  ): Promise<void> {
    const finishedAt = this.clock.now();
    await this.prisma.jobRun
      .update({
        where: { id },
        data: {
          status: 'FAILED',
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          errorMessage: this.errorMessage(error).slice(0, 255),
        },
      })
      .catch((recordError: unknown) => {
        this.logger.warn(
          { err: recordError, runId: id },
          'Could not record the failure of job run',
        );
      });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
