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

  get logHttpSuccess(): boolean {
    return this.value('LOG_HTTP_SUCCESS');
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

  get schedulerEnabled(): boolean {
    return this.value('SCHEDULER_ENABLED');
  }

  get jobs(): {
    settleIntervalMs: number;
    renewalOrdersIntervalMs: number;
    expireOrdersIntervalMs: number;
    syncPaymentsIntervalMs: number;
    notificationsIntervalMs: number;
    batchSize: number;
    lockTtlMs: number;
  } {
    return {
      settleIntervalMs: this.value('JOB_SETTLE_INTERVAL_MS'),
      renewalOrdersIntervalMs: this.value('JOB_RENEWAL_ORDERS_INTERVAL_MS'),
      expireOrdersIntervalMs: this.value('JOB_EXPIRE_ORDERS_INTERVAL_MS'),
      syncPaymentsIntervalMs: this.value('JOB_SYNC_PAYMENTS_INTERVAL_MS'),
      notificationsIntervalMs: this.value('JOB_NOTIFICATIONS_INTERVAL_MS'),
      batchSize: this.value('JOB_BATCH_SIZE'),
      lockTtlMs: this.value('JOB_LOCK_TTL_MS'),
    };
  }

  get notifications(): {
    batchSize: number;
    maxAttempts: number;
    timeZone: string;
    webAppUrl: string;
  } {
    return {
      batchSize: this.value('NOTIFICATION_BATCH_SIZE'),
      maxAttempts: this.value('NOTIFICATION_MAX_ATTEMPTS'),
      timeZone: this.value('NOTIFICATION_TIME_ZONE'),
      webAppUrl: this.value('WEB_APP_URL'),
    };
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

  get license(): {
    privateKey: string;
    kid: string;
    issuer: string;
    audience: string;
    tokenTtlSeconds: number;
    offlineTtlDays: number;
  } {
    return {
      privateKey: this.value('LICENSE_JWT_PRIVATE_KEY'),
      kid: this.value('LICENSE_JWT_KID'),
      issuer: this.value('LICENSE_JWT_ISSUER'),
      audience: this.value('LICENSE_JWT_AUDIENCE'),
      tokenTtlSeconds: this.value('LICENSE_TTL_SECONDS'),
      offlineTtlDays: this.value('LICENSE_OFFLINE_TTL_DAYS'),
    };
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

  get paymentProvider(): Env['PAYMENT_PROVIDER'] {
    return this.value('PAYMENT_PROVIDER');
  }

  get orderTtlMinutes(): number {
    return this.value('ORDER_TTL_MINUTES');
  }

  get renewalLeadDays(): number {
    return this.value('RENEWAL_LEAD_DAYS');
  }

  get latePaymentGraceMinutes(): number {
    return this.value('LATE_PAYMENT_GRACE_MINUTES');
  }

  get paymentSyncWindowHours(): number {
    return this.value('PAYMENT_SYNC_WINDOW_HOURS');
  }

  get alipay(): {
    appId: string;
    privateKey: string;
    publicKey: string;
    gatewayUrl: string;
    notifyUrl: string;
    returnUrl: string;
  } {
    return {
      appId: this.value('ALIPAY_APP_ID'),
      privateKey: this.value('ALIPAY_PRIVATE_KEY'),
      publicKey: this.value('ALIPAY_PUBLIC_KEY'),
      gatewayUrl: this.value('ALIPAY_GATEWAY_URL'),
      notifyUrl: this.value('PAYMENT_NOTIFY_URL'),
      returnUrl: this.value('PAYMENT_RETURN_URL'),
    };
  }
}
