import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { AppConfig } from '../../config/app-config.service';
import { AppConfigModule } from '../../config/config.module';

/** Probe and key-discovery traffic carries no operational signal. */
const QUIET_PATHS = new Set([
  '/health',
  '/health/ready',
  '/.well-known/jwks.json',
  '/favicon.ico',
]);

/** The path is the key; query strings regularly carry short-lived secrets. */
const pathOf = (url: string | undefined): string =>
  (url ?? '').split('?')[0] ?? '';

const isQuiet = (
  method: string | undefined,
  url: string | undefined,
): boolean =>
  method === 'OPTIONS' ||
  pathOf(url).startsWith('/docs') ||
  QUIET_PATHS.has(pathOf(url));

interface RequestContext {
  readonly id?: string;
  readonly method?: string;
  readonly url?: string;
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const pinoHttp: Options = {
          level: config.logLevel,

          // Reuse an upstream request id when a gateway or the client already
          // supplied one, and echo it back so a support ticket can be traced.
          genReqId: (req, res) => {
            const header = req.headers['x-request-id'];
            const requestId =
              (Array.isArray(header) ? header[0] : header) ?? randomUUID();
            res.setHeader('x-request-id', requestId);
            return requestId;
          },

          // One request is one line: method, path, status and timing. Headers
          // (security headers, rate-limit counters, user-agent) are noise and
          // are deliberately not serialized.
          serializers: {
            req: (req) => {
              const request = req as unknown as RequestContext;
              return {
                id: request.id,
                method: request.method,
                url: pathOf(request.url),
              };
            },
            res: (res) => ({ statusCode: res.statusCode }),
          },

          // Liveness probes and key discovery would otherwise dominate volume.
          autoLogging: {
            ignore: (req) => isQuiet(req.method, req.url),
          },

          customLogLevel: (_req, res, err) => {
            if (err || res.statusCode >= 500) {
              return 'error';
            }
            if (res.statusCode >= 400) {
              return 'warn';
            }
            return config.logHttpSuccess ? 'info' : 'silent';
          },

          customSuccessMessage: (req, res) =>
            `${req.method} ${pathOf(req.url)} ${res.statusCode}`,
          customErrorMessage: (req, res) =>
            `${req.method} ${pathOf(req.url)} ${res.statusCode}`,

          // Defence in depth: the serializers above already drop headers, but
          // an unexpected serializer change must not leak credentials.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },
        };

        if (config.logFormat === 'pretty') {
          pinoHttp.transport = {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              // The pid and hostname are constant in a local process.
              ignore: 'pid,hostname',
            },
          };
        }

        return { pinoHttp };
      },
    }),
  ],
})
export class LoggerModule {}
