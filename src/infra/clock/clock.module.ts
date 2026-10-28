import { Global, Module } from '@nestjs/common';
import { Clock } from './clock';
import { SystemClock } from './system-clock';

/**
 * Global like `AppConfigModule`: every feature already injects configuration
 * without importing anything, and every feature that reasons about time needs
 * the same. Tests replace the binding, not the module graph.
 */
@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
