import { z } from 'zod';

const planIntervalSchema = z.enum(['MONTH', 'YEAR']);

const productCodeSchema = z.string().trim().min(1).max(64);
const planCodeSchema = z.string().trim().min(1).max(64);

export const createSubscriptionSchema = z.object({
  productCode: productCodeSchema,
  planCode: planCodeSchema,
  interval: planIntervalSchema,
  currency: z.string().trim().length(3).toLowerCase().default('cny'),
  // Paid purchases go through `POST /orders`; this route only starts trials.
  trial: z.literal(true),
});

/**
 * The target terms are resolved and frozen when the request is accepted; the
 * change itself only lands at the end of the current period, so there is no
 * timing switch here.
 */
export const changeSubscriptionSchema = z
  .object({
    planCode: planCodeSchema.optional(),
    interval: planIntervalSchema.optional(),
  })
  .refine(
    (value) => value.planCode !== undefined || value.interval !== undefined,
    { message: 'A change needs a planCode or an interval' },
  );

export const subscriptionParamsSchema = z.object({
  id: z.string().trim().min(1).max(191),
});

export const subscriptionChangeParamsSchema = z.object({
  id: z.string().trim().min(1).max(191),
  changeId: z.string().trim().min(1).max(191),
});

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type ChangeSubscriptionInput = z.infer<typeof changeSubscriptionSchema>;
