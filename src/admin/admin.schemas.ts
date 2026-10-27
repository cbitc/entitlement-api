import { z } from 'zod';
import { paginationSchema } from '../common/http/pagination';

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
  name: z.enum(['renewal-orders', 'settle', 'expire-orders', 'sync-payments']),
});

export const adminRunJobSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

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
