import { Clock } from '../../src/infra/clock/clock';

/**
 * A clock the test drives.
 *
 * It follows the wall clock until a test pins it, so timestamps written by the
 * database (`@default(now())`) and by the provider gateway still line up with
 * the application's idea of now. `set` pins an absolute instant; `advance`
 * shifts relative time and keeps ticking. `reset` returns to real time, which
 * an `afterEach` should do so one case cannot leak a shifted clock into the
 * next.
 */
export class FakeClock extends Clock {
  /** When set, time stands still at this instant (plus any advance). */
  private pinned: Date | null;
  /** Applied to the wall clock while time is not pinned. */
  private offsetMs = 0;

  constructor(start?: Date | string) {
    super();
    this.pinned = start === undefined ? null : new Date(start);
  }

  now(): Date {
    // A copy: a caller mutating the result must not move the clock.
    return this.pinned
      ? new Date(this.pinned)
      : new Date(Date.now() + this.offsetMs);
  }

  /** Jump to an absolute instant and stand still there. */
  set(instant: Date | string): this {
    this.pinned = new Date(instant);
    this.offsetMs = 0;
    return this;
  }

  /** Move forward (or backward, for a negative value) by milliseconds. */
  advance(ms: number): this {
    if (this.pinned) {
      this.pinned = new Date(this.pinned.getTime() + ms);
    } else {
      this.offsetMs += ms;
    }
    return this;
  }

  advanceDays(days: number): this {
    return this.advance(days * 24 * 60 * 60 * 1000);
  }

  /** Back to the real wall clock. */
  reset(): this {
    this.pinned = null;
    this.offsetMs = 0;
    return this;
  }
}
