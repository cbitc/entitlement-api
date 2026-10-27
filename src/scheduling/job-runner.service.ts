import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { AppConfig } from '../config/app-config.service';
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
export class JobRunnerService {
  private readonly logger = new Logger(JobRunnerService.name);
  private readonly instanceId = `${hostname()}:${process.pid}`.slice(0, 128);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly lock: JobLockService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
  ) {}

  async run(
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
      if (options.source === 'admin') {
        const record = await this.prisma.jobRun.create({
          data: {
            name,
            status: 'SKIPPED',
            instanceId: this.instanceId,
            finishedAt: new Date(),
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

    const startedAt = new Date();
    let recordId: string | null = null;

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

      const result = await this.execute(name, options.limit, startedAt);
      await this.recordSuccess(record.id, startedAt, result);
      return { runId: record.id, status: 'SUCCEEDED', result };
    } catch (error) {
      // A failure before the row exists still has to release the lease; a
      // failure after it exists should leave a trace an operator can read.
      if (recordId) {
        await this.recordFailure(recordId, startedAt, error);
      }
      throw error;
    } finally {
      await this.lock.release(name, owner).catch((releaseError: unknown) => {
        this.logger.warn(
          `Could not release the ${name} job lease: ${this.errorMessage(releaseError)}`,
        );
      });
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

  private async recordSuccess(
    id: string,
    startedAt: Date,
    result: unknown,
  ): Promise<void> {
    const finishedAt = new Date();
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
        this.logger.warn(
          `Could not finish job run ${id}: ${this.errorMessage(error)}`,
        );
      });
  }

  private async recordFailure(
    id: string,
    startedAt: Date,
    error: unknown,
  ): Promise<void> {
    const finishedAt = new Date();
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
          `Could not record the failure of job run ${id}: ${this.errorMessage(
            recordError,
          )}`,
        );
      });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
