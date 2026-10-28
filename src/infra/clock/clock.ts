/**
 * The only source of "now" for business logic.
 *
 * Reading the wall clock directly (`new Date()`) makes time-dependent rules —
 * trial expiry, period boundaries, checkout deadlines, verification-code
 * throttling — impossible to drive from a test without touching the database
 * or the host clock. Injecting this port instead means a test can place the
 * application at any instant and exercise the same code path production uses.
 *
 * This is *business* time only. Two clocks stay real on purpose:
 * - the database clock (`NOW(3)`) arbitrates job leases across replicas;
 * - protocol timestamps (Alipay) must match the network's idea of now.
 */
export abstract class Clock {
  /** The current instant. Callers must not mutate the returned value. */
  abstract now(): Date;
}
