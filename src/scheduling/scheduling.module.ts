import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from '../config/config.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { JobLockService } from './job-lock.service';
import { JobRunnerService } from './job-runner.service';
import { ScheduledJobsService } from './scheduled-jobs.service';

/**
 * The only place that decides *when* a job runs.
 *
 * The jobs themselves stay where their invariants live (`OrdersService`,
 * `NotificationsService`); this module adds leasing, scheduling and run
 * history around them.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    AppConfigModule,
    OrdersModule,
    NotificationsModule,
  ],
  providers: [JobLockService, JobRunnerService, ScheduledJobsService],
  exports: [JobLockService, JobRunnerService],
})
export class SchedulingModule {}
