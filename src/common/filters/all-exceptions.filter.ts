import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';
import { AppConfig } from '../../config/app-config.service';
import { AppException } from '../errors/app.exception';
import { formatZodError } from '../zod/format-zod-error';

/** The only error shape the API returns. Clients rely on it verbatim. */
export interface ErrorEnvelope {
  error: {
    type: string;
    message: string;
  };
}

interface MappedError {
  status: number;
  type: string;
  message: string;
}

/**
 * Maps a status code to the machine-readable error type used in the envelope.
 * Keeping one table makes every endpoint answer with the same vocabulary.
 */
const STATUS_TYPES: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'ValidationError',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'NotFound',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'MethodNotAllowed',
  [HttpStatus.NOT_ACCEPTABLE]: 'NotAcceptable',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PayloadTooLarge',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UnsupportedMediaType',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UnprocessableEntity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TooManyRequests',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'ServiceUnavailable',
};

/**
 * Last line of defence: turns anything thrown inside the request pipeline into
 * the canonical error envelope, and makes sure an unexpected failure is logged
 * with its stack while an expected one is not.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    private readonly config: AppConfig,
  ) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    const mapped = this.map(exception);

    if (mapped.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        {
          err: exception,
          reqId: request.id,
          method: request.method,
          path: request.originalUrl,
          status: mapped.status,
        },
        'request failed',
      );
    }

    const body: ErrorEnvelope = {
      error: { type: mapped.type, message: mapped.message },
    };
    response.status(mapped.status).json(body);
  }

  private map(exception: unknown): MappedError {
    if (exception instanceof AppException) {
      return {
        status: exception.status,
        type: exception.type,
        message: exception.message,
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        type: 'ValidationError',
        message: formatZodError(exception),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaError(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return this.unexpected('Invalid database request');
    }

    if (exception instanceof HttpException) {
      return this.mapHttpException(exception);
    }

    const message =
      exception instanceof Error ? exception.message : String(exception);
    return this.unexpected(message);
  }

  private mapHttpException(exception: HttpException): MappedError {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    let message: string;

    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      // ThrottlerException's own message is "ThrottlerException: Too Many
      // Requests", which is an implementation detail, not API copy.
      message = 'Too many requests, please retry later';
    } else if (typeof payload === 'string') {
      message = payload;
    } else {
      const body = payload as { message?: string | string[] };
      message = Array.isArray(body.message)
        ? body.message.join('; ')
        : (body.message ?? exception.message);
    }

    return { status, type: STATUS_TYPES[status] ?? 'HttpError', message };
  }

  private mapPrismaError(
    error: Prisma.PrismaClientKnownRequestError,
  ): MappedError {
    switch (error.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          type: 'Conflict',
          message: 'A record with the same unique value already exists',
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          type: 'Conflict',
          message: 'The operation violates a relation constraint',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          type: 'NotFound',
          message: 'The requested record does not exist',
        };
      default:
        return this.unexpected(`Unhandled database error ${error.code}`);
    }
  }

  /**
   * Internal failures must not leak implementation details in production; the
   * request log keeps them for the operator.
   */
  private unexpected(message: string): MappedError {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      type: 'InternalError',
      message: this.config.isProduction ? 'Internal server error' : message,
    };
  }
}
