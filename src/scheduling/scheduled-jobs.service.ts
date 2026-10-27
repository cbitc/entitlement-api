import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfig } from '../config/app-config.service';
import { JobRunnerService } from './job-runner.service';
import type { JobName } from './job.types';

interface TimerHandle {
  readonly name: string;
  readonly kind: 'interval' | 'timeout';
  readonly handle: NodeJS.Timeout;
}

/**
 * Drives the job runner from in-process timers.
 *
 * Intervals are read from configuration rather than hard-coded in decorators,
 * because an operator needs to slow the sweeps down without a rebuild. The
 * timers are unref'd so a test that leaves the app booted still exits, and
 * they are removed on shutdown so `start:dev` reloads do not stack tickers.
 */
@Injectable()
export class ScheduledJobsService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ScheduledJobsService.name);
  private readonly timers: TimerHandle[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly registry: SchedulerRegistry,
    private readonly runner: JobRunnerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.schedulerEnabled) {
      this.logger.log(
        'Scheduler disabled; jobs run only through the admin trigger',
      );
      return;
    }

    const jobs = this.config.jobs;
    const definitions: ReadonlyArray<{
      readonly name: JobName;
      readonly intervalMs: number;
    }> = [
      { name: 'settle', intervalMs: jobs.settleIntervalMs },
      { name: 'renewal-orders', intervalMs: jobs.renewalOrdersIntervalMs },
      { name: 'expire-orders', intervalMs: jobs.expireOrdersIntervalMs },
      { name: 'sync-payments', intervalMs: jobs.syncPaymentsIntervalMs },
      { name: 'notifications', intervalMs: jobs.notificationsIntervalMs },
    ];

    for (const definition of definitions) {
      this.register(definition.name, definition.intervalMs);
    }

    this.logger.log(
      `Scheduler started: ${definitions
        .map((definition) => `${definition.name}@${definition.intervalMs}ms`)
        .join(', ')}`,
    );
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) {
      if (timer.kind === 'interval') {
        clearInterval(timer.handle);
      } else {
        clearTimeout(timer.handle);
      }
      if (this.registry.doesExist('interval', timer.name)) {
        this.registry.deleteInterval(timer.name);
      }
    }
    this.timers.length = 0;
  }

  private register(name: JobName, intervalMs: number): void {
    const registryName = `job:${name}`;

    if (this.registry.doesExist('interval', registryName)) {
      this.registry.deleteInterval(registryName);
    }

    const interval = setInterval(() => {
      void this.tick(name);
    }, intervalMs);
    interval.unref();
    this.registry.addInterval(registryName, interval);
    this.timers.push({
      name: registryName,
      kind: 'interval',
      handle: interval,
    });

    // Run shortly after boot instead of waiting a whole interval, with jitter
    // so replicas that restart together do not all sweep in the same second.
    const kickDelay = Math.floor(Math.random() * 10_000);
    const kick = setTimeout(() => {
      void this.tick(name);
    }, kickDelay);
    kick.unref();
    this.timers.push({
      name: `${registryName}:kick`,
      kind: 'timeout',
      handle: kick,
    });
  }

  private async tick(name: JobName): Promise<void> {
    try {
      await this.runner.run(name, {
        limit: this.config.jobs.batchSize,
        source: 'scheduler',
      });
    } catch (error) {
      // A failing batch must never kill the interval; the next tick retries.
      this.logger.error(
        `Scheduled job ${name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
