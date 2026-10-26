import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';

/**
 * Turns a provider/gateway failure into a 502.
 *
 * Payment providers are upstream services: a timeout is not a bug in this API,
 * and the caller must be able to distinguish it from a rejected request.
 */
export const paymentProviderFailed = (message: string): AppException =>
  new AppException('PaymentProviderError', HttpStatus.BAD_GATEWAY, message);
