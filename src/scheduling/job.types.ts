/**
 * The jobs the process can run.
 *
 * Shared by the scheduler, the admin trigger and the request schema so a new
 * job cannot be added to one entry point and silently missing from another.
 */
import type { JobRunStatus } from '@prisma/client';

export const JOB_NAMES = [
  'renewal-orders',
  'settle',
  'expire-orders',
  'sync-payments',
  'notifications',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

/** Who asked for the run; scheduled skips are not worth a history row. */
export type JobSource = 'scheduler' | 'admin';

export type JobRunOutcome = 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface JobOutcome {
  readonly runId: string | null;
  readonly status: JobRunOutcome;
  readonly result?: unknown;
}

export interface JobRunView {
  readonly id: string;
  readonly name: string;
  readonly status: JobRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly result: unknown;
  readonly errorMessage: string | null;
  readonly instanceId: string;
}
