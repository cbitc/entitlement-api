import { createHash, randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';

export interface FakeIdentity {
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly subject?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
}

interface PendingCode {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

/**
 * A minimal OIDC provider for e2e tests.
 *
 * It serves discovery, a JWKS and a token endpoint that really validates the
 * PKCE code_verifier and signs a real id_token with RS256 — so the API's token
 * verification runs end to end instead of being stubbed out.
 *
 * Listening on an ephemeral port means `SSO_ISSUER` is only known once the
 * server is up; the spec therefore imports `AppModule` dynamically afterwards
 * (configuration is validated at module import time).
 */
export class FakeOidcProvider {
  private readonly server: Server;
  private readonly pending = new Map<string, PendingCode>();
  private privateKey: CryptoKey | null = null;
  private publicJwk: JWK | null = null;
  private baseUrl = '';

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get issuer(): string {
    return this.baseUrl;
  }

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.privateKey = privateKey;
    this.publicJwk = {
      ...(await exportJWK(publicKey)),
      kid: 'fake-1',
      alg: 'RS256',
      use: 'sig',
    };

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo;
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /** Issues an authorization code that is redeemable once. */
  mintCode(identity: FakeIdentity): string {
    const code = randomBytes(16).toString('base64url');
    this.pending.set(code, {
      subject: identity.subject ?? 'subject-1',
      email: identity.email ?? 'buyer@example.com',
      emailVerified: identity.emailVerified ?? true,
      name: identity.name ?? 'Test Buyer',
      nonce: identity.nonce,
      codeChallenge: identity.codeChallenge,
    });
    return code;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (
        request.method === 'GET' &&
        url.pathname === '/.well-known/openid-configuration'
      ) {
        this.json(response, 200, {
          issuer: this.baseUrl,
          authorization_endpoint: `${this.baseUrl}/authorize`,
          token_endpoint: `${this.baseUrl}/token`,
          jwks_uri: `${this.baseUrl}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/jwks') {
        this.json(response, 200, { keys: [this.publicJwk] });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/token') {
        await this.token(request, response);
        return;
      }

      this.json(response, 404, { error: 'not_found' });
    } catch (error) {
      this.json(response, 500, {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private async token(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = new URLSearchParams(await readBody(request));
    const code = body.get('code') ?? '';
    const pending = this.pending.get(code);
    // A code is single use, exactly like a real provider.
    this.pending.delete(code);

    if (
      !pending ||
      body.get('grant_type') !== 'authorization_code' ||
      body.get('client_id') !== this.clientId ||
      body.get('client_secret') !== this.clientSecret ||
      body.get('redirect_uri') !== this.redirectUri
    ) {
      this.json(response, 400, { error: 'invalid_grant' });
      return;
    }

    const verifier = body.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== pending.codeChallenge) {
      this.json(response, 400, {
        error: 'invalid_grant',
        error_description: 'PKCE verification failed',
      });
      return;
    }

    if (!this.privateKey) {
      this.json(response, 500, { error: 'server_error' });
      return;
    }

    const idToken = await new SignJWT({
      email: pending.email,
      email_verified: pending.emailVerified,
      name: pending.name,
      nonce: pending.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-1', typ: 'JWT' })
      .setIssuer(this.baseUrl)
      .setAudience(this.clientId)
      .setSubject(pending.subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.privateKey);

    this.json(response, 200, {
      access_token: 'fake-access-token',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};
