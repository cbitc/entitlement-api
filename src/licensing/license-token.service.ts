import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  type CryptoKey,
  type JWK,
} from 'jose';
import { AppConfig } from '../config/app-config.service';

/** Claims a license token carries. `sub` is the owning user id. */
export interface IssueLicenseTokenInput {
  readonly userId: string;
  readonly product: string;
  readonly plan: string;
  readonly trial: boolean;
  readonly machineId: string;
  /** Offline tokens get the longer TTL, still capped by the grant. */
  readonly offline: boolean;
  /** Hard ceiling: the grant's own expiry. */
  readonly expiresAt: Date;
}

export interface IssuedLicenseToken {
  readonly token: string;
  /** Effective expiry after the TTL cap. */
  readonly expiresAt: Date;
}

/** The public half clients fetch from `/.well-known/jwks.json`. */
export interface LicenseJwk extends JWK {
  readonly kid: string;
  readonly alg: 'EdDSA';
  readonly use: 'sig';
}

/**
 * Mints short-lived EdDSA license tokens.
 *
 * Session tokens and license tokens deliberately use different algorithms,
 * audiences and keys: a session is a browser credential, while a license is
 * verified offline by an installed application long after it was issued.
 *
 * The public JWK is derived from the private key at boot, so a deployment only
 * has to distribute one secret. The private scalar (`d`) is always stripped
 * before the JWK is exposed.
 */
@Injectable()
export class LicenseTokenService implements OnModuleInit {
  private readonly logger = new Logger(LicenseTokenService.name);
  private privateKey!: CryptoKey;
  private publicJwk!: LicenseJwk;

  constructor(private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    const settings = this.config.license;

    if (settings.privateKey.trim().length === 0) {
      if (this.config.isProduction) {
        // `env.schema.ts` already refuses this; keep a clear failure if the
        // service is ever constructed outside the normal bootstrap.
        throw new Error('LICENSE_JWT_PRIVATE_KEY is required in production');
      }

      const pair = await generateKeyPair('Ed25519', { extractable: true });
      const jwk = await exportJWK(pair.publicKey);
      this.privateKey = pair.privateKey;
      this.publicJwk = this.withKeyMetadata(jwk);
      this.logger.warn(
        'LICENSE_JWT_PRIVATE_KEY is empty: using an ephemeral Ed25519 key. ' +
          'License tokens will stop verifying after a restart; configure a ' +
          'persistent key before deploying.',
      );
      return;
    }

    try {
      // `extractable: true` is required because the public JWK is derived
      // from the private key below.
      const key = await importPKCS8(
        normalizePkcs8(settings.privateKey),
        'EdDSA',
        { extractable: true },
      );
      const jwk = await exportJWK(key);
      // `importPKCS8` returns a private key; never publish its scalar.
      delete (jwk as { d?: string }).d;
      this.privateKey = key;
      this.publicJwk = this.withKeyMetadata(jwk);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `LICENSE_JWT_PRIVATE_KEY is not a valid PKCS#8 Ed25519 key: ${reason}`,
      );
    }
  }

  /** JWKS document; safe to serve anonymously. */
  jwks(): { keys: readonly LicenseJwk[] } {
    return { keys: [this.publicJwk] };
  }

  async issue(
    input: IssueLicenseTokenInput,
    now: Date = new Date(),
  ): Promise<IssuedLicenseToken> {
    const settings = this.config.license;
    const ttlMs = input.offline
      ? settings.offlineTtlDays * 24 * 60 * 60 * 1000
      : settings.tokenTtlSeconds * 1000;
    const expiresAt = new Date(
      Math.min(now.getTime() + ttlMs, input.expiresAt.getTime()),
    );

    const issuedAtSeconds = Math.floor(now.getTime() / 1000);
    const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
    if (expiresAtSeconds <= issuedAtSeconds) {
      throw new Error('The license period has already ended');
    }

    const token = await new SignJWT({
      product: input.product,
      plan: input.plan,
      trial: input.trial,
      machineId: input.machineId,
      ...(input.offline ? { offline: true } : {}),
    })
      .setProtectedHeader({
        alg: 'EdDSA',
        kid: settings.kid,
        typ: 'JWT',
      })
      .setSubject(input.userId)
      .setIssuer(settings.issuer)
      .setAudience(settings.audience)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.privateKey);

    return { token, expiresAt };
  }

  private withKeyMetadata(jwk: JWK): LicenseJwk {
    return {
      ...jwk,
      kid: this.config.license.kid,
      alg: 'EdDSA',
      use: 'sig',
    };
  }
}

/**
 * Accepts either a full PEM or the raw base64 DER commonly pasted into
 * `LICENSE_JWT_PRIVATE_KEY`.
 */
const normalizePkcs8 = (value: string): string => {
  const trimmed = value.trim().replace(/\\n/g, '\n');
  if (trimmed.includes('-----BEGIN')) {
    return trimmed;
  }

  const der = trimmed.replace(/\s+/g, '');
  const lines = der.match(/.{1,64}/g)?.join('\n') ?? der;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
};
