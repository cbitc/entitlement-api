import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppConfig } from '../../config/app-config.service';
import { AppException } from '../errors/app.exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

const createHost = () => {
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        id: 'request-1',
        method: 'GET',
        originalUrl: '/resource',
      }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, response };
};

const createFilter = (isProduction = false) => {
  const logger = {
    setContext: vi.fn(),
    error: vi.fn(),
  } as unknown as PinoLogger;
  const config = { isProduction } as AppConfig;
  return { filter: new AllExceptionsFilter(logger, config), logger };
};

describe('AllExceptionsFilter', () => {
  it('keeps the type and status of an AppException', () => {
    const { filter } = createFilter();
    const { host, response } = createHost();

    filter.catch(
      AppException.conflict('Already subscribed', 'SubscriptionAlreadyActive'),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        type: 'SubscriptionAlreadyActive',
        message: 'Already subscribed',
      },
    });
  });

  it('maps an HttpException to its status type', () => {
    const { filter } = createFilter();
    const { host, response } = createHost();

    filter.catch(new BadRequestException('Bad payload'), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: { type: 'ValidationError', message: 'Bad payload' },
    });
  });

  it('replaces the throttler implementation detail with API copy', () => {
    const { filter } = createFilter();
    const { host, response } = createHost();

    filter.catch(new ThrottlerException(), host);

    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        type: 'TooManyRequests',
        message: 'Too many requests, please retry later',
      },
    });
  });

  it('maps a raw ZodError to a 400 envelope', () => {
    const { filter } = createFilter();
    const { host, response } = createHost();
    const result = z.object({ email: z.email() }).safeParse({ email: 'nope' });

    filter.catch(result.error, host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        type: 'ValidationError',
        message: expect.stringContaining('email'),
      },
    });
  });

  it('logs unexpected failures and hides their message in production', () => {
    const { filter, logger } = createFilter(true);
    const { host, response } = createHost();

    filter.catch(new Error('connection string leaked'), host);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: { type: 'InternalError', message: 'Internal server error' },
    });
  });

  it('exposes the failure detail outside production', () => {
    const { filter } = createFilter(false);
    const { host, response } = createHost();

    filter.catch(new Error('boom'), host);

    expect(response.json).toHaveBeenCalledWith({
      error: { type: 'InternalError', message: 'boom' },
    });
  });
});
