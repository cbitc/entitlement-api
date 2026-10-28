import { z } from 'zod';
import { paginationSchema } from '../common/http/pagination';
import { JOB_NAMES } from '../scheduling/job.types';

const idSchema = z.string().trim().min(1).max(191);
const codeSchema = z.string().trim().min(1).max(64);
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const nullableText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

/* Users ------------------------------------------------------------------ */

export const adminUserQuerySchema = paginationSchema.extend({
  email: z.string().trim().max(254).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  role: z.enum(['CUSTOMER', 'ADMIN']).optional(),
});

export const adminUserParamsSchema = z.object({ id: idSchema });

export const adminUpdateUserSchema = z
  .object({
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    role: z.enum(['CUSTOMER', 'ADMIN']).optional(),
  })
  .refine((value) => value.status !== undefined || value.role !== undefined, {
    message: 'Provide status or role',
  });

/* Subscriptions ---------------------------------------------------------- */

export const adminSubscriptionQuerySchema = paginationSchema.extend({
  userId: idSchema.optional(),
  productId: idSchema.optional(),
  status: z
    .enum(['TRIALING', 'ACTIVE', 'PAUSED', 'CANCELED', 'EXPIRED'])
    .optional(),
  planVersionId: idSchema.optional(),
  endsBefore: z.coerce.date().optional(),
});

export const adminSubscriptionParamsSchema = z.object({ id: idSchema });

/* Orders ----------------------------------------------------------------- */

export const adminOrderQuerySchema = paginationSchema.extend({
  status: z
    .enum(['PENDING', 'PAID', 'FULFILLED', 'CLOSED', 'REFUNDED'])
    .optional(),
  userId: idSchema.optional(),
  number: z.string().trim().min(1).max(32).optional(),
  productId: idSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const adminOrderParamsSchema = z.object({ id: idSchema });

/* Jobs ------------------------------------------------------------------- */

export const adminJobParamsSchema = z.object({
  name: z.enum(JOB_NAMES),
});

export const adminRunJobSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const adminJobRunQuerySchema = z.object({
  name: z.enum(JOB_NAMES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/* Clock (integration testing) -------------------------------------------- */

/** A year either way is already far beyond any renewal or trial window. */
const MAX_CLOCK_SHIFT_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Exactly one intent per call, so the resulting state is never ambiguous:
 * `now` freezes time, `offsetMs` shifts the running clock, `reset` returns to
 * the wall clock.
 */
export const adminSetClockSchema = z
  .object({
    now: z.coerce.date().optional(),
    offsetMs: z.coerce
      .number()
      .int()
      .min(-MAX_CLOCK_SHIFT_MS)
      .max(MAX_CLOCK_SHIFT_MS)
      .optional(),
    reset: z.literal(true).optional(),
  })
  .refine(
    (value) =>
      [value.now, value.offsetMs, value.reset].filter(
        (field) => field !== undefined,
      ).length === 1,
    { message: 'Send exactly one of: now, offsetMs, reset' },
  );

/** Human-friendly travel: any combination of units is summed. */
export const adminAdvanceClockSchema = z
  .object({
    ms: z.coerce.number().int().optional(),
    seconds: z.coerce.number().int().optional(),
    minutes: z.coerce.number().int().optional(),
    hours: z.coerce.number().int().optional(),
    days: z.coerce.number().int().min(-365).max(365).optional(),
  })
  .refine(
    (value) =>
      [value.ms, value.seconds, value.minutes, value.hours, value.days].some(
        (field) => field !== undefined,
      ),
    { message: 'Send at least one of: ms, seconds, minutes, hours, days' },
  );

/* Notifications ---------------------------------------------------------- */

export const adminNotificationQuerySchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'SENDING', 'SENT', 'FAILED']).optional(),
  type: z
    .enum(['PAYMENT_SUCCEEDED', 'SUBSCRIPTION_EXPIRED', 'REFUND_ISSUED'])
    .optional(),
  email: z.string().trim().max(254).optional(),
  userId: idSchema.optional(),
});

export const adminNotificationParamsSchema = z.object({ id: idSchema });

export type AdminNotificationQuery = z.output<
  typeof adminNotificationQuerySchema
>;
export type AdminNotificationParams = z.output<
  typeof adminNotificationParamsSchema
>;
export type AdminJobRunQuery = z.output<typeof adminJobRunQuerySchema>;
export type AdminSetClockInput = z.output<typeof adminSetClockSchema>;
export type AdminAdvanceClockInput = z.output<typeof adminAdvanceClockSchema>;

/* Licenses --------------------------------------------------------------- */

export const adminLicenseQuerySchema = paginationSchema.extend({
  email: emailSchema.optional(),
  userId: idSchema.optional(),
  product: codeSchema.optional(),
});

export const adminActivationParamsSchema = z.object({ id: idSchema });

/* Catalogue -------------------------------------------------------------- */

const priceSchema = z.object({
  interval: z.enum(['MONTH', 'YEAR']),
  currency: z.string().trim().length(3).toLowerCase().default('cny'),
  priceCents: z.number().int().min(0).max(100_000_000),
});

const featureCodesSchema = z.array(codeSchema).max(200);

export const adminProductParamsSchema = z.object({ id: idSchema });
export const adminPlanParamsSchema = z.object({ id: idSchema });
export const adminVersionParamsSchema = z.object({ id: idSchema });

export const adminCreateProductSchema = z.object({
  code: codeSchema,
  displayName: z.string().trim().min(1).max(120),
  description: nullableText(5000),
  vendor: nullableText(120),
  websiteUrl: nullableText(2048),
  iconUrl: nullableText(2048),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
});

export const adminUpdateProductSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  description: nullableText(5000),
  vendor: nullableText(120),
  websiteUrl: nullableText(2048),
  iconUrl: nullableText(2048),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
});

export const adminCreatePlanSchema = z.object({
  code: codeSchema,
  displayName: z.string().trim().min(1).max(120),
  description: nullableText(5000),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

export const adminUpdatePlanSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  description: nullableText(5000),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

/**
 * A new version starts as a draft. Everything is optional when copying an
 * existing version; the copy is a starting point, not a re-publication.
 */
export const adminCreateVersionSchema = z.object({
  copyFromVersionId: idSchema.optional(),
  maxActivations: z.number().int().min(1).max(1000).optional(),
  trialDays: z.number().int().min(0).max(3650).optional(),
  trialMaxActivations: z.number().int().min(1).max(1000).optional(),
  prices: z.array(priceSchema).max(20).optional(),
  features: featureCodesSchema.optional(),
});

/** Only a DRAFT may be edited, and only these four things. */
export const adminUpdateVersionSchema = z.object({
  maxActivations: z.number().int().min(1).max(1000).optional(),
  trialDays: z.number().int().min(0).max(3650).optional(),
  trialMaxActivations: z.number().int().min(1).max(1000).optional(),
  prices: z.array(priceSchema).max(20).optional(),
  features: featureCodesSchema.optional(),
});

export const adminCreateFeatureSchema = z.object({
  code: codeSchema,
  displayName: z.string().trim().min(1).max(120),
  description: nullableText(5000),
});

export type AdminUserQuery = z.output<typeof adminUserQuerySchema>;
export type AdminUserParams = z.output<typeof adminUserParamsSchema>;
export type AdminUpdateUserInput = z.output<typeof adminUpdateUserSchema>;
export type AdminSubscriptionQueryInput = z.output<
  typeof adminSubscriptionQuerySchema
>;
export type AdminSubscriptionParams = z.output<
  typeof adminSubscriptionParamsSchema
>;
export type AdminOrderQueryInput = z.output<typeof adminOrderQuerySchema>;
export type AdminOrderParams = z.output<typeof adminOrderParamsSchema>;
export type AdminJobParams = z.output<typeof adminJobParamsSchema>;
export type AdminRunJobInput = z.output<typeof adminRunJobSchema>;
export type AdminLicenseQueryInput = z.output<typeof adminLicenseQuerySchema>;
export type AdminActivationParams = z.output<
  typeof adminActivationParamsSchema
>;
export type AdminProductParams = z.output<typeof adminProductParamsSchema>;
export type AdminPlanParams = z.output<typeof adminPlanParamsSchema>;
export type AdminVersionParams = z.output<typeof adminVersionParamsSchema>;
export type AdminCreateProductInput = z.output<typeof adminCreateProductSchema>;
export type AdminUpdateProductInput = z.output<typeof adminUpdateProductSchema>;
export type AdminCreatePlanInput = z.output<typeof adminCreatePlanSchema>;
export type AdminUpdatePlanInput = z.output<typeof adminUpdatePlanSchema>;
export type AdminCreateVersionInput = z.output<typeof adminCreateVersionSchema>;
export type AdminUpdateVersionInput = z.output<typeof adminUpdateVersionSchema>;
export type AdminCreateFeatureInput = z.output<typeof adminCreateFeatureSchema>;
