import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { ZodBody } from '../common/http/zod.decorators';
import {
  ClockControl,
  type ClockSnapshot,
} from '../infra/clock/clock-control.service';
import {
  adminAdvanceClockSchema,
  adminSetClockSchema,
  type AdminAdvanceClockInput,
  type AdminSetClockInput,
} from './admin.schemas';
import type { ClockStateView } from './admin.types';

const toView = (state: ClockSnapshot): ClockStateView => ({
  enabled: state.enabled,
  controlled: state.controlled,
  now: state.now.toISOString(),
  realNow: state.realNow.toISOString(),
  offsetMs: state.offsetMs,
  pinnedAt: state.pinnedAt === null ? null : state.pinnedAt.toISOString(),
});

/**
 * Moves the application clock so support staff can walk a subscription through
 * trial expiry, renewal, settlement, checkout deadlines and license expiry
 * without waiting or editing rows.
 *
 * Enabled only when `CLOCK_CONTROL_ENABLED` is on, which production refuses at
 * boot. While it is off every write answers 404, so an environment that never
 * opted in does not advertise the capability.
 *
 * Two clocks deliberately stay real: the database clock that arbitrates job
 * leases (`NOW(3)`) and the provider protocol timestamps sent to Alipay.
 */
@ApiTags('admin')
@ApiBearerAuth('session')
@Roles('ADMIN')
@Controller('admin/clock')
export class AdminClockController {
  constructor(
    private readonly clock: ClockControl,
    private readonly pino: PinoLogger,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Read the application clock (admin)' })
  @ApiOkResponse({ description: 'Current application time and its drift' })
  state(): ClockStateView {
    return toView(this.clock.snapshot());
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pin, shift or reset the application clock (admin)',
  })
  @ApiOkResponse({ description: 'The new clock state' })
  set(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(adminSetClockSchema) body: AdminSetClockInput,
  ): ClockStateView {
    const before = this.clock.snapshot();

    const next =
      body.reset === true
        ? this.clock.reset()
        : body.offsetMs !== undefined
          ? this.clock.setOffset(body.offsetMs)
          : this.clock.setNow(body.now as Date);

    this.audit(current, before, next, 'set');
    return toView(next);
  }

  @Post('advance')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Move the application clock forward or back (admin)',
  })
  @ApiOkResponse({ description: 'The new clock state' })
  advance(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(adminAdvanceClockSchema) body: AdminAdvanceClockInput,
  ): ClockStateView {
    const before = this.clock.snapshot();
    const ms =
      (body.ms ?? 0) +
      (body.seconds ?? 0) * 1000 +
      (body.minutes ?? 0) * 60_000 +
      (body.hours ?? 0) * 3_600_000 +
      (body.days ?? 0) * 86_400_000;

    const next = this.clock.advance(ms);
    this.audit(current, before, next, 'advance');
    return toView(next);
  }

  /** Time travel changes what every later assertion means, so it is audited. */
  private audit(
    actor: AuthenticatedUser,
    before: ClockSnapshot,
    after: ClockSnapshot,
    action: 'set' | 'advance',
  ): void {
    this.pino.info(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action,
        before: {
          now: before.now.toISOString(),
          offsetMs: before.offsetMs,
          pinnedAt: before.pinnedAt?.toISOString() ?? null,
        },
        after: {
          now: after.now.toISOString(),
          offsetMs: after.offsetMs,
          pinnedAt: after.pinnedAt?.toISOString() ?? null,
        },
      },
      'Application clock changed',
    );
  }
}
