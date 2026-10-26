import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed façade over the validated environment.
 *
 * Reading configuration through getters keeps `ConfigService` string lookups
 * out of the feature code and gives the compiler a chance to catch a typo.
 */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private value<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true }) as Env[K];
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.value('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get appName(): string {
    return this.value('APP_NAME');
  }

  get appVersion(): string {
    return this.value('APP_VERSION');
  }

  get host(): string {
    return this.value('HOST');
  }

  get port(): number {
    return this.value('PORT');
  }

  get databaseUrl(): string {
    return this.value('DATABASE_URL');
  }

  get logLevel(): Env['LOG_LEVEL'] {
    return this.value('LOG_LEVEL');
  }

  get logFormat(): Env['LOG_FORMAT'] {
    return this.value('LOG_FORMAT');
  }

  get bodyLimit(): string {
    return this.value('BODY_LIMIT');
  }

  get corsOrigins(): string[] {
    return this.value('CORS_ORIGINS');
  }

  get swaggerEnabled(): boolean {
    return this.value('SWAGGER_ENABLED');
  }

  get swaggerPath(): string {
    return this.value('SWAGGER_PATH');
  }

  get throttleTtlMs(): number {
    return this.value('THROTTLE_TTL_MS');
  }

  get throttleLimit(): number {
    return this.value('THROTTLE_LIMIT');
  }
}
