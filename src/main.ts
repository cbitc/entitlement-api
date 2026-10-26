import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { setupSwagger } from './common/openapi/setup-swagger';
import { AppConfig } from './config/app-config.service';

const bootstrap = async (): Promise<void> => {
  // `bufferLogs` holds Nest's own startup messages until the pino logger is
  // attached, so early output uses the final format too.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(AppConfig);
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Lets Prisma disconnect and in-flight requests finish on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // Swagger UI ships inline scripts, which the default CSP would block; the
  // policy stays on everywhere else.
  app.use(
    helmet({ contentSecurityPolicy: config.isProduction ? undefined : false }),
  );

  app.enableCors({
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });

  app.useBodyParser('json', { limit: config.bodyLimit });
  // Alipay posts its asynchronous notifications as a form, not JSON.
  app.useBodyParser('urlencoded', {
    limit: config.bodyLimit,
    extended: true,
  });

  if (config.swaggerEnabled) {
    setupSwagger(app, config);
  }

  await app.listen(config.port, config.host);
  logger.log(
    `HTTP server listening on http://${config.host}:${config.port} (${config.nodeEnv})`,
  );
};

bootstrap().catch((error: unknown) => {
  // The logger is not available if the module graph failed to compile.
  console.error('Failed to start the application', error);
  process.exit(1);
});
