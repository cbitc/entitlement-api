import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { AppConfigModule } from '../../config/config.module';
import { AdjustableClock } from './adjustable-clock';
import { Clock } from './clock';
import { ClockControl } from './clock-control.service';
import { SystemClock } from './system-clock';

/**
 * Global like `AppConfigModule`: every feature already injects configuration
 * without importing anything, and every feature that reasons about time needs
 * the same. Tests replace the binding, not the module graph.
 *
 * The adjustable clock is only bound when `CLOCK_CONTROL_ENABLED` is on
 * (development only, enforced by the env schema). Production therefore cannot
 * be moved even if the admin route were reachable.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: Clock,
      inject: [AppConfig],
      useFactory: (config: AppConfig): Clock =>
        config.clockControlEnabled ? new AdjustableClock() : new SystemClock(),
    },
    {
      provide: ClockControl,
      inject: [Clock, AppConfig],
      useFactory: (clock: Clock, config: AppConfig): ClockControl =>
        new ClockControl(
          clock,
          config.clockControlEnabled && clock instanceof AdjustableClock
            ? clock
            : null,
        ),
    },
  ],
  exports: [Clock, ClockControl],
})
export class ClockModule {}
