import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { AppConfig } from '../../config/app-config.service';
import { AppConfigModule } from '../../config/config.module';

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

          // Never let credentials reach the log stream.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
            censor: '[redacted]',
          },

          // Liveness probes would otherwise dominate the log volume.
          autoLogging: {
            ignore: (req) => req.url === '/health',
          },

          customLogLevel: (_req, res, err) => {
            if (err || res.statusCode >= 500) {
              return 'error';
            }
            return res.statusCode >= 400 ? 'warn' : 'info';
          },
        };

        if (config.logFormat === 'pretty') {
          pinoHttp.transport = {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
            },
          };
        }

        return { pinoHttp };
      },
    }),
  ],
})
export class LoggerModule {}
