import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config.service';
import { OidcClient } from './oidc.client';

const CLIENT_ID = 'entitlement-api';
const NONCE = 'nonce-1';

let server: Server;
let issuer = '';
let privateKey: CryptoKey;
let publicJwk: JWK;

const sendJson = (response: ServerResponse, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'test-1',
    alg: 'RS256',
    use: 'sig',
  };

  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/.well-known/openid-configuration') {
      sendJson(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
      return;
    }
    if (path === '/jwks') {
      sendJson(response, { keys: [publicJwk] });
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      issuer = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

const createClient = (): OidcClient =>
  new OidcClient({
    sso: {
      issuer,
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      redirectUri: 'http://localhost:3000/auth/sso/callback',
      scopes: ['openid', 'profile', 'email'],
      stateTtlSeconds: 600,
      ticketTtlSeconds: 60,
      httpTimeoutMs: 2000,
      allowedEmailDomains: [],
    },
  } as unknown as AppConfig);

const signIdToken = async (
  claims: Record<string, unknown> = {},
  options: {
    issuer?: string;
    audience?: string;
    expiresAt?: number;
  } = {},
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: 'Buyer@Example.com',
    email_verified: true,
    name: 'Test Buyer',
    nonce: NONCE,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? CLIENT_ID)
    .setSubject('subject-1')
    .setIssuedAt(now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(privateKey);
};

describe('OidcClient.verifyIdToken', () => {
  it('returns the normalised claims of a valid token', async () => {
    const client = createClient();

    await expect(
      client.verifyIdToken(await signIdToken(), NONCE),
    ).resolves.toEqual({
      subject: 'subject-1',
      email: 'buyer@example.com',
      emailVerified: true,
      name: 'Test Buyer',
    });
  });

  it('rejects a token minted for another login attempt', async () => {
    const client = createClient();

    await expect(
      client.verifyIdToken(await signIdToken(), 'other-nonce'),
    ).rejects.toMatchObject({ type: 'SsoTokenInvalid' });
  });

  it('rejects a token from another issuer', async () => {
    const client = createClient();

    await expect(
      client.verifyIdToken(
        await signIdToken({}, { issuer: 'https://idp.example' }),
        NONCE,
      ),
    ).rejects.toMatchObject({ type: 'SsoTokenInvalid' });
  });

  it('rejects a token minted for another client', async () => {
    const client = createClient();

    await expect(
      client.verifyIdToken(
        await signIdToken({}, { audience: 'another-client' }),
        NONCE,
      ),
    ).rejects.toMatchObject({ type: 'SsoTokenInvalid' });
  });

  it('rejects an expired token', async () => {
    const client = createClient();
    const expired = Math.floor(Date.now() / 1000) - 600;

    await expect(
      client.verifyIdToken(
        await signIdToken({}, { expiresAt: expired }),
        NONCE,
      ),
    ).rejects.toMatchObject({ type: 'SsoTokenInvalid' });
  });

  it('rejects a token without an email address', async () => {
    const client = createClient();

    await expect(
      client.verifyIdToken(await signIdToken({ email: undefined }), NONCE),
    ).rejects.toMatchObject({ type: 'SsoEmailMissing' });
  });

  it('treats a missing email_verified claim as unverified', async () => {
    const client = createClient();

    await expect(
      client.verifyIdToken(
        await signIdToken({ email_verified: undefined }),
        NONCE,
      ),
    ).resolves.toMatchObject({ emailVerified: false });
  });
});

describe('OidcClient.authorizationUrl', () => {
  it('carries PKCE, state and nonce', async () => {
    const client = createClient();

    const url = new URL(
      await client.authorizationUrl({
        state: 'state-1',
        nonce: NONCE,
        codeChallenge: 'challenge-1',
      }),
    );

    expect(url.origin).toBe(issuer);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe(NONCE);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
  });
});
