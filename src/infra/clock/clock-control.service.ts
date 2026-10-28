import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { AdjustableClock, type ClockState } from './adjustable-clock';
import { Clock } from './clock';

/** The state the console renders, including whether control is even allowed. */
export interface ClockSnapshot extends ClockState {
  readonly enabled: boolean;
}

/**
 * The only write path to the application clock.
 *
 * Keeping the guard here rather than in the controller means any future caller
 * (a CLI, a test harness, a different route) cannot move time without passing
 * the same switch. When control is disabled the writes answer 404, so an
 * environment that never opted in does not even reveal that the feature exists.
 */
@Injectable()
export class ClockControl {
  constructor(
    private readonly clock: Clock,
    /** Null unless `CLOCK_CONTROL_ENABLED` bound the adjustable clock. */
    private readonly adjustable: AdjustableClock | null,
  ) {}

  get enabled(): boolean {
    return this.adjustable !== null;
  }

  snapshot(): ClockSnapshot {
    if (this.adjustable) {
      return { enabled: true, ...this.adjustable.state() };
    }
    const now = this.clock.now();
    return {
      enabled: false,
      controlled: false,
      pinnedAt: null,
      offsetMs: 0,
      now,
      realNow: this.clock.now(),
    };
  }

  setNow(instant: Date): ClockSnapshot {
    this.writable().pin(instant);
    return this.snapshot();
  }

  setOffset(ms: number): ClockSnapshot {
    this.writable().setOffset(ms);
    return this.snapshot();
  }

  advance(ms: number): ClockSnapshot {
    this.writable().advance(ms);
    return this.snapshot();
  }

  reset(): ClockSnapshot {
    this.writable().reset();
    return this.snapshot();
  }

  private writable(): AdjustableClock {
    if (!this.adjustable) {
      throw AppException.notFound(
        'Clock control is not enabled on this deployment',
        'ClockControlDisabled',
      );
    }
    return this.adjustable;
  }
}
