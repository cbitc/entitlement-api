/** How long an issued code stays redeemable. */
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;

/** Minimum gap between two codes for the same address. */
export const LOGIN_CODE_RESEND_INTERVAL_MS = 60 * 1000;

/** Wrong guesses allowed before the code is abandoned. */
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
