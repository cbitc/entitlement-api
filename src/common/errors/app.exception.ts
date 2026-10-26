import { HttpStatus } from '@nestjs/common';

/**
 * An expected failure with an HTTP status and a stable machine-readable type.
 *
 * `type` is part of the public error envelope (`error.type`); clients branch on
 * it, so it must not change casually. Everything that is not an `AppException`
 * is treated as a programming error by the global filter.
 */
export class AppException extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppException';
  }

  static validation(message: string): AppException {
    return new AppException('ValidationError', HttpStatus.BAD_REQUEST, message);
  }

  static unauthorized(message = 'Authentication is required'): AppException {
    return new AppException('Unauthorized', HttpStatus.UNAUTHORIZED, message);
  }

  static forbidden(message = 'Insufficient permissions'): AppException {
    return new AppException('Forbidden', HttpStatus.FORBIDDEN, message);
  }

  static notFound(
    message = 'The requested resource does not exist',
    type = 'NotFound',
  ): AppException {
    return new AppException(type, HttpStatus.NOT_FOUND, message);
  }

  static conflict(message: string, type = 'Conflict'): AppException {
    return new AppException(type, HttpStatus.CONFLICT, message);
  }

  /** A resource that existed but is no longer available (e.g. an expired code). */
  static gone(message: string, type = 'Gone'): AppException {
    return new AppException(type, HttpStatus.GONE, message);
  }

  static tooManyRequests(message = 'Too many requests'): AppException {
    return new AppException(
      'TooManyRequests',
      HttpStatus.TOO_MANY_REQUESTS,
      message,
    );
  }

  static internal(message = 'Internal server error'): AppException {
    return new AppException(
      'InternalError',
      HttpStatus.INTERNAL_SERVER_ERROR,
      message,
    );
  }
}
