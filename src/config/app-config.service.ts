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

  get jwtSecret(): string {
    return this.value('JWT_SECRET');
  }

  get jwtIssuer(): string {
    return this.value('JWT_ISSUER');
  }

  get jwtAudience(): string {
    return this.value('JWT_AUDIENCE');
  }

  get jwtTtlSeconds(): number {
    return this.value('JWT_TTL_SECONDS');
  }

  /** Key material for the verification-code HMAC, with a safe fallback. */
  get verificationCodeSecret(): string {
    return this.value('VERIFICATION_CODE_SECRET') ?? this.jwtSecret;
  }

  get mailTransport(): Env['MAIL_TRANSPORT'] {
    return this.value('MAIL_TRANSPORT');
  }

  get smtp(): {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  } {
    return {
      host: this.value('SMTP_HOST'),
      port: this.value('SMTP_PORT'),
      secure: this.value('SMTP_SECURE'),
      user: this.value('SMTP_USER'),
      password: this.value('SMTP_PASSWORD'),
      from: this.value('SMTP_FROM'),
    };
  }
}
