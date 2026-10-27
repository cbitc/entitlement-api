/**
 * Generates the Ed25519 key pair used to sign license tokens.
 *
 * Prints the two environment values and the public JWKS document. Keep the
 * private key out of source control; only `.env` (gitignored) or the deployment
 * secret store should hold it.
 *
 * Usage: node scripts/generate-license-key.mjs [kid]
 */
import { createHash, generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicJwk = publicKey.export({ format: 'jwk' });
const privateDer = privateKey
  .export({ type: 'pkcs8', format: 'der' })
  .toString('base64');

const kid =
  process.argv[2]?.trim() ||
  `lic-${createHash('sha256').update(publicJwk.x).digest('base64url').slice(0, 8)}`;

const jwks = {
  keys: [{ ...publicJwk, kid, alg: 'EdDSA', use: 'sig' }],
};

console.log('# Add these to .env (never commit the private key).');
console.log(`LICENSE_JWT_PRIVATE_KEY="${privateDer}"`);
console.log(`LICENSE_JWT_KID="${kid}"`);
console.log('');
console.log('# Public keys served at /.well-known/jwks.json:');
console.log(JSON.stringify(jwks, null, 2));
