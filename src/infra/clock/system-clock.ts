import { Injectable } from '@nestjs/common';
import { Clock } from './clock';

/**
 * The production clock: a fresh `Date` per call, so callers cannot accidentally
 * share a mutable instant.
 */
@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    // The one place allowed to read the wall clock (see eslint.config.mjs).
    return new Date();
  }
}
