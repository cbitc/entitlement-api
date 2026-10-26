import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfig } from '../../config/app-config.service';

/**
 * Publishes the OpenAPI document and the Swagger UI.
 *
 * Mounted under `/docs` by default; disabled in production unless the
 * environment explicitly opts in.
 */
export const setupSwagger = (
  app: INestApplication,
  config: AppConfig,
): void => {
  const documentConfig = new DocumentBuilder()
    .setTitle('Entitlement API')
    .setDescription('Subscription, entitlement and licensing API')
    .setVersion(config.appVersion)
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'session',
    )
    .build();

  const document = SwaggerModule.createDocument(app, documentConfig);
  SwaggerModule.setup(config.swaggerPath, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
};
