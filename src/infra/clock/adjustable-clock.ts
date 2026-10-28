import { Clock } from './clock';

/**
 * What the control endpoint reports.
 *
 * `pinnedAt` and `offsetMs` are two different test intents: a pin freezes the
 * clock at one instant (assert "at exactly this moment"), an offset keeps it
 * running from a shifted origin (assert "a week later"). They are mutually
 * exclusive so the reported state is never ambiguous.
 */
export interface ClockState {
  /** The instant time is frozen at, or null while it follows the wall clock. */
  readonly pinnedAt: Date | null;
  /** Shift applied to the wall clock while it is not pinned. */
  readonly offsetMs: number;
  /** The business instant every service sees. */
  readonly now: Date;
  /** The wall clock, unaffected by the shift; for side-by-side display. */
  readonly realNow: Date;
  /** Whether a test has moved time away from the wall clock. */
  readonly controlled: boolean;
}

/**
 * A clock an administrator can move, for integration testing against a running
 * server (`POST /admin/clock`).
 *
 * It is only ever bound as the application clock when `CLOCK_CONTROL_ENABLED`
 * is on, which production refuses at boot. Every business service already
 * reads time through `Clock`, so moving this object moves trials, renewals,
 * settlement, checkout deadlines, license expiry and code throttling at once —
 * without touching the database or the host clock.
 */
export class AdjustableClock extends Clock {
  private pinnedAt: Date | null = null;
  private offsetMs = 0;

  now(): Date {
    // A copy per call: a caller mutating the result cannot move the clock.
    return this.pinnedAt !== null
      ? new Date(this.pinnedAt)
      : new Date(Date.now() + this.offsetMs);
  }

  /** Freeze at an absolute instant. */
  pin(instant: Date): void {
    this.pinnedAt = new Date(instant);
    this.offsetMs = 0;
  }

  /** Shift the running clock relative to the wall clock. */
  setOffset(ms: number): void {
    this.pinnedAt = null;
    this.offsetMs = ms;
  }

  /** Move forward (or backward, for a negative value) from wherever it is. */
  advance(ms: number): void {
    if (this.pinnedAt !== null) {
      this.pinnedAt = new Date(this.pinnedAt.getTime() + ms);
      return;
    }
    this.offsetMs += ms;
  }

  /** Back to the wall clock. */
  reset(): void {
    this.pinnedAt = null;
    this.offsetMs = 0;
  }

  get controlled(): boolean {
    return this.pinnedAt !== null || this.offsetMs !== 0;
  }

  state(): ClockState {
    return {
      pinnedAt: this.pinnedAt === null ? null : new Date(this.pinnedAt),
      offsetMs: this.offsetMs,
      now: this.now(),
      realNow: new Date(),
      controlled: this.controlled,
    };
  }
}
