import type { ZodError } from 'zod';

const MAX_REPORTED_ISSUES = 3;

/**
 * Renders a zod failure as `field: message`, which is what clients see in
 * `error.message`. Only the first few issues are reported: an attacker must not
 * learn the whole schema from one response.
 */
export const formatZodError = (error: ZodError): string => {
  const details = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return details.length > 0 ? details.join('; ') : 'Invalid request payload';
};
