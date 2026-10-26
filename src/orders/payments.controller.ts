import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/public.decorator';
import { OrdersService } from './orders.service';

/**
 * Provider callback surface.
 *
 * Providers retry until they receive the exact string `success`, so anything we
 * accepted (including an ignored or rejected event we stored) answers with it;
 * only an unexpected server failure returns `failure` and triggers a retry.
 */
@ApiExcludeController()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly orders: OrdersService) {}

  @Public()
  @SkipThrottle()
  @Post(':provider/notify')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async notify(
    @Param('provider') provider: string,
    @Body() body: Record<string, string>,
  ): Promise<string> {
    const accepted = await this.orders.handleNotification(provider, body ?? {});
    return accepted ? 'success' : 'failure';
  }
}
