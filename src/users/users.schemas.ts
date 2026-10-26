import { z } from 'zod';

export const updateProfileSchema = z.object({
  /** `null` clears the name; the email is the identity and never changes here. */
  displayName: z.string().trim().min(1).max(120).nullable(),
});

export type UpdateProfileInput = z.output<typeof updateProfileSchema>;
