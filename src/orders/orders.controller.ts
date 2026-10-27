import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-user';
import { Roles } from '../common/auth/roles.decorator';
import { ZodBody, ZodParam } from '../common/http/zod.decorators';
import {
  createOrderSchema,
  orderParamsSchema,
  refundOrderSchema,
  type CreateOrderInput,
  type RefundOrderInput,
} from './orders.schemas';
import { OrdersService } from './orders.service';
import type { CheckoutView, OrderView } from './orders.types';

type OrderParams = { readonly id: string };

@ApiTags('orders')
@ApiBearerAuth('session')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Create an unpaid order for a paid subscription' })
  @ApiCreatedResponse({ description: 'The pending order' })
  create(
    @CurrentUser() current: AuthenticatedUser,
    @ZodBody(createOrderSchema) body: CreateOrderInput,
  ): Promise<OrderView> {
    return this.orders.create(current.id, body);
  }

  @Get()
  @ApiOperation({ summary: 'The caller orders, newest first' })
  @ApiOkResponse({ description: 'Orders' })
  list(@CurrentUser() current: AuthenticatedUser): Promise<OrderView[]> {
    return this.orders.listForUser(current.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One order of the caller' })
  @ApiOkResponse({ description: 'The order' })
  get(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(orderParamsSchema) params: OrderParams,
  ): Promise<OrderView> {
    return this.orders.getForUser(current.id, params.id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close an unpaid order' })
  @ApiOkResponse({ description: 'The closed order' })
  cancel(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(orderParamsSchema) params: OrderParams,
  ): Promise<OrderView> {
    return this.orders.cancel(current.id, params.id);
  }

  @Post(':id/payments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a checkout for an unpaid order' })
  @ApiOkResponse({ description: 'Payment attempt with its redirect URL' })
  pay(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(orderParamsSchema) params: OrderParams,
  ): Promise<CheckoutView> {
    return this.orders.createPayment(current.id, params.id);
  }

  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reconcile an order with the provider (for lost callbacks)',
  })
  @ApiOkResponse({ description: 'The order after reconciliation' })
  sync(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(orderParamsSchema) params: OrderParams,
  ): Promise<OrderView> {
    return this.orders.sync(current.id, params.id);
  }

  @Post(':id/refunds')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund a captured payment (admin)' })
  @ApiOkResponse({ description: 'The order with its refund' })
  refund(
    @CurrentUser() current: AuthenticatedUser,
    @ZodParam(orderParamsSchema) params: OrderParams,
    @ZodBody(refundOrderSchema) body: RefundOrderInput,
  ): Promise<OrderView> {
    return this.orders.refund(current.id, params.id, body);
  }
}
